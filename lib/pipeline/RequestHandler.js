'use strict';

const Duplex  = require('readable-stream').Duplex;
const agent = require('../agent');
const logger = agent.logger;
const metrics = agent.metrics;

class RequestHandler extends Duplex {
  constructor(options) {
    super({
      writableObjectMode: true,
      readableObjectMode: true,
      highWaterMark: 50
    });
    this.db = options.db;
    this.queue = [];
  }

  _commonReponseHandler(request, callback) {
    const start = Date.now();
    return (err, result) => {
      const took = Date.now() - start;

      const tags = {
        method: request.method,
        type: request.type
      };

      if (result &&
        typeof result.conformant !== 'undefined' &&
        result.conformant !== null) {
        tags.conformant = result.conformant;
      }

      metrics.histogram('limitd.database.took', took, tags);

      if (err) {
        if (err.message.indexOf('undefined bucket type') > -1) {
          if (request.skipResponse) {
            logger.info({
              log_type: 'unknown_bucket_error',
              request,
              err
            }, 'Error detected in the request pipeline.');
          } else {
            this._queueResponse(request, { error: { type: 'UNKNOWN_BUCKET_TYPE' } });
          }
        } else {
          this.emit('error', err);
        }
        return callback();
      }

      logger.info({
        took:       took,
        method:     request.method,
        type:       request.type,
        key:        request.key,
        conformant: result.conformant
      }, request.method);

      if (!request.skipResponse) {
        this._queueResponse(request, result);
      }

      callback();
    };
  }

  _write(request, encoding, callback) {
    logger.debug({ request },'request');

    switch(request.method) {
      case 'PING':
        this._queueResponse(request, { request_id: request.id });
        return callback();
      case 'TAKE':
        return this.db.take(request, this._commonReponseHandler(request, callback));
      case 'WAIT':
        return this.db.wait(request, this._commonReponseHandler(request, callback));
      case 'PUT':
        return this.db.put(request, this._commonReponseHandler(request, callback));
      case 'GET':
        return this.db.get(request, this._commonReponseHandler(request, callback));
      case 'STATUS':
        return this.db.status({type: request.type, prefix: request.key}, (err, result) => {
          if (err) { return this.emit('error', err); }
          this._queueResponse(request, result);
          callback();
        });
      default:
        return callback(new Error(`unknown method ${request.method}`));
    }
  }

  _writev(chunks, callback) {
    var finished = 0, err;
    const done = (_err) => {
      finished++;
      err = err || _err;
      if (finished === chunks.length) {
        return callback(err);
      }
    };

    //faster than async.each
    for(var i = 0; i < chunks.length; i++) {
      this._write(chunks[i].chunk, null, done);
    }
  }

  _queueResponse(request, response) {
    this.queue.push({ request, response });
    this._flush();
  }

  _flush() {
    var i;

    //faster than deque.
    for(i = 0; i < this.queue.length && this.reading ; i++) {
      this.reading = this.push(this.queue[i]);
    }

    this.queue = i === this.queue.length ? [] : this.queue.slice(i);
  }

  _read() {
    this.reading = true;
    this._flush();
  }
}

module.exports = RequestHandler;
