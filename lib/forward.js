'use strict';

const config = require('wild-config');
const maildrop = require('./maildrop');

module.exports = (options, callback) => {
    if (!config.sender.enabled) {
        return callback(null, false);
    }

    let message = maildrop(
        {
            from: options.sender,
            to: options.recipient,

            forward: options.forward,
            http: !!options.targetUrl,
            targeUrl: options.targetUrl,

            interface: 'forwarder'
        },
        callback
    );

    setImmediate(() => {
        let pos = 0;
        let writeNextChunk = () => {
            if (pos >= options.chunks.length) {
                return message.end();
            }
            let chunk = options.chunks[pos++];
            if (!message.write(chunk)) {
                return message.once('drain', writeNextChunk);
            } else {
                setImmediate(writeNextChunk);
            }
        };
        setImmediate(writeNextChunk);
    });
};
