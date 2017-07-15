'use strict';

const db = require('../db');

// UNSUBSCRIBE "path/to/mailbox"
module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'unsubscribe',
            cid: session.id
        },
        '[%s] UNSUBSCRIBE from "%s"',
        session.id,
        path
    );
    db.database.collection('mailboxes').findOneAndUpdate({
        user: session.user.id,
        path
    }, {
        $set: {
            subscribed: false
        }
    }, {}, (err, item) => {
        if (err) {
            return callback(err);
        }

        if (!item || !item.value) {
            // was not able to acquire a lock
            return callback(null, 'NONEXISTENT');
        }

        callback(null, true);
    });
};
