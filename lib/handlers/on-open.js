'use strict';

const db = require('../db');

// SELECT/EXAMINE
module.exports = server => (path, session, callback) => {
    server.logger.debug(
        {
            tnx: 'open',
            cid: session.id
        },
        '[%s] Opening "%s"',
        session.id,
        path
    );
    db.database.collection('mailboxes').findOne({
        user: session.user.id,
        path
    }, (err, mailbox) => {
        if (err) {
            return callback(err);
        }
        if (!mailbox) {
            return callback(null, 'NONEXISTENT');
        }

        db.database
            .collection('messages')
            .find({
                mailbox: mailbox._id
            })
            .project({
                uid: true
            })
            .sort([['uid', 1]])
            .toArray((err, messages) => {
                if (err) {
                    return callback(err);
                }
                mailbox.uidList = messages.map(message => message.uid);
                callback(null, mailbox);
            });
    });
};
