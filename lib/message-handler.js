'use strict';

const crypto = require('crypto');
const uuidV1 = require('uuid/v1');
const ObjectID = require('mongodb').ObjectID;
const Indexer = require('../imap-core/lib/indexer/indexer');
const ImapNotifier = require('./imap-notifier');
const AttachmentStorage = require('./attachment-storage');
const libmime = require('libmime');
const counters = require('./counters');
const consts = require('./consts');
const tools = require('./tools');
const openpgp = require('openpgp');
const parseDate = require('../imap-core/lib/parse-date');

// index only the following headers for SEARCH
const INDEXED_HEADERS = ['to', 'cc', 'subject', 'from', 'sender', 'reply-to', 'message-id', 'thread-index'];

openpgp.config.commentstring = 'Plaintext message encrypted by Wild Duck Mail Server';

class MessageHandler {
    constructor(options) {
        this.database = options.database;
        this.redis = options.redis;

        this.attachmentStorage =
            options.attachmentStorage ||
            new AttachmentStorage({
                gridfs: options.gridfs || options.database,
                options: options.attachments
            });

        this.indexer = new Indexer({
            attachmentStorage: this.attachmentStorage
        });

        this.notifier = new ImapNotifier({
            database: options.database,
            redis: this.redis,
            pushOnly: true
        });

        this.users = options.users || options.database;
        this.counters = counters(this.redis);
    }

    getMailbox(options, callback) {
        let query = {};
        if (options.mailbox) {
            if (typeof options.mailbox === 'object' && options.mailbox._id) {
                return setImmediate(() => callback(null, options.mailbox));
            }
            query._id = options.mailbox;
            if (options.user) {
                query.user = options.user;
            }
        } else {
            query.user = options.user;
            if (options.specialUse) {
                query.specialUse = options.specialUse;
            } else {
                query.path = options.path;
            }
        }

        this.database.collection('mailboxes').findOne(query, (err, mailbox) => {
            if (err) {
                return callback(err);
            }

            if (!mailbox) {
                let err = new Error('Mailbox is missing');
                err.imapResponse = 'TRYCREATE';
                return callback(err);
            }

            callback(null, mailbox);
        });
    }

    // Monster method for inserting new messages to a mailbox
    // TODO: Refactor into smaller pieces
    add(options, callback) {
        let prepared = options.prepared || this.prepareMessage(options);

        let id = prepared.id;
        let mimeTree = prepared.mimeTree;
        let size = prepared.size;
        let bodystructure = prepared.bodystructure;
        let envelope = prepared.envelope;
        let idate = prepared.idate;
        let hdate = prepared.hdate;
        let msgid = prepared.msgid;
        let subject = prepared.subject;
        let headers = prepared.headers;

        let flags = Array.isArray(options.flags) ? options.flags : [].concat(options.flags || []);
        let maildata = options.maildata || this.indexer.getMaildata(id, mimeTree);

        this.getMailbox(options, (err, mailboxData) => {
            if (err) {
                return callback(err);
            }

            this.checkExistingMessage(
                mailboxData,
                {
                    hdate,
                    msgid,
                    flags
                },
                options,
                (...args) => {
                    if (args[0] || args[1]) {
                        return callback(...args);
                    }

                    let cleanup = (...args) => {
                        if (!args[0]) {
                            return callback(...args);
                        }

                        let attachmentIds = Object.keys(mimeTree.attachmentMap || {}).map(key => mimeTree.attachmentMap[key]);
                        if (!attachmentIds.length) {
                            return callback(...args);
                        }

                        this.attachmentStorage.deleteMany(attachmentIds, maildata.magic, () => callback(...args));
                    };

                    this.indexer.storeNodeBodies(id, maildata, mimeTree, err => {
                        if (err) {
                            return cleanup(err);
                        }

                        // prepare message object
                        let messageData = {
                            _id: id,

                            // should be kept when COPY'ing or MOVE'ing
                            root: id,

                            v: consts.SCHEMA_VERSION,

                            // if true then expires after rdate + retention
                            exp: !!mailboxData.retention,
                            rdate: Date.now() + (mailboxData.retention || 0),

                            idate,
                            hdate,
                            flags,
                            size,

                            // some custom metadata about the delivery
                            meta: options.meta || {},

                            // list filter IDs that matched this message
                            filters: Array.isArray(options.filters) ? options.filters : [].concat(options.filters || []),

                            headers,
                            mimeTree,
                            envelope,
                            bodystructure,
                            msgid,

                            // use boolean for more commonly used (and searched for) flags
                            unseen: !flags.includes('\\Seen'),
                            flagged: flags.includes('\\Flagged'),
                            undeleted: !flags.includes('\\Deleted'),
                            draft: flags.includes('\\Draft'),

                            magic: maildata.magic,

                            subject
                        };

                        if (maildata.attachments && maildata.attachments.length) {
                            messageData.attachments = maildata.attachments;
                            messageData.ha = true;
                        } else {
                            messageData.ha = false;
                        }

                        if (maildata.text) {
                            messageData.text = maildata.text.replace(/\r\n/g, '\n').trim();
                            // text is indexed with a fulltext index, so only store the beginning of it
                            messageData.text =
                                messageData.text.length <= consts.MAX_PLAINTEXT_CONTENT
                                    ? messageData.text
                                    : messageData.text.substr(0, consts.MAX_PLAINTEXT_CONTENT);
                            messageData.intro = messageData.text.replace(/\s+/g, ' ').trim();
                            if (messageData.intro.length > 128) {
                                let intro = messageData.intro.substr(0, 128);
                                let lastSp = intro.lastIndexOf(' ');
                                if (lastSp > 0) {
                                    intro = intro.substr(0, lastSp);
                                }
                                messageData.intro = intro + '…';
                            }
                        }

                        if (maildata.html && maildata.html.length) {
                            let htmlSize = 0;
                            messageData.html = maildata.html
                                .map(html => {
                                    if (htmlSize >= consts.MAX_HTML_CONTENT || !html) {
                                        return '';
                                    }

                                    if (htmlSize + Buffer.byteLength(html) <= consts.MAX_HTML_CONTENT) {
                                        htmlSize += Buffer.byteLength(html);
                                        return html;
                                    }

                                    html = html.substr(0, htmlSize + Buffer.byteLength(html) - consts.MAX_HTML_CONTENT);
                                    htmlSize += Buffer.byteLength(html);
                                    return html;
                                })
                                .filter(html => html);
                        }

                        this.users.collection('users').findOneAndUpdate({
                            _id: mailboxData.user
                        }, {
                            $inc: {
                                storageUsed: size
                            }
                        }, err => {
                            if (err) {
                                return cleanup(err);
                            }

                            let rollback = err => {
                                this.users.collection('users').findOneAndUpdate({
                                    _id: mailboxData.user
                                }, {
                                    $inc: {
                                        storageUsed: -size
                                    }
                                }, () => {
                                    cleanup(err);
                                });
                            };

                            // acquire new UID+MODSEQ
                            this.database.collection('mailboxes').findOneAndUpdate({
                                _id: mailboxData._id
                            }, {
                                $inc: {
                                    // allocate bot UID and MODSEQ values so when journal is later sorted by
                                    // modseq then UIDs are always in ascending order
                                    uidNext: 1,
                                    modifyIndex: 1
                                }
                            }, (err, item) => {
                                if (err) {
                                    return rollback(err);
                                }

                                if (!item || !item.value) {
                                    // was not able to acquire a lock
                                    let err = new Error('Mailbox is missing');
                                    err.imapResponse = 'TRYCREATE';
                                    return rollback(err);
                                }

                                let mailboxData = item.value;

                                // updated message object by setting mailbox specific values
                                messageData.mailbox = mailboxData._id;
                                messageData.user = mailboxData.user;
                                messageData.uid = mailboxData.uidNext;
                                messageData.modseq = mailboxData.modifyIndex + 1;

                                if (!['\\Junk', '\\Trash'].includes(mailboxData.specialUse) && !flags.includes('\\Deleted')) {
                                    messageData.searchable = true;
                                }

                                if (mailboxData.specialUse === '\\Junk') {
                                    messageData.junk = true;
                                }

                                this.getThreadId(mailboxData.user, subject, mimeTree, (err, thread) => {
                                    if (err) {
                                        return rollback(err);
                                    }

                                    messageData.thread = thread;

                                    this.database.collection('messages').insertOne(messageData, err => {
                                        if (err) {
                                            return rollback(err);
                                        }

                                        let uidValidity = mailboxData.uidValidity;
                                        let uid = messageData.uid;

                                        if (options.session && options.session.selected && options.session.selected.mailbox === mailboxData.path) {
                                            options.session.writeStream.write(options.session.formatResponse('EXISTS', messageData.uid));
                                        }

                                        this.notifier.addEntries(
                                            mailboxData,
                                            false,
                                            {
                                                command: 'EXISTS',
                                                uid: messageData.uid,
                                                ignore: options.session && options.session.id,
                                                message: messageData._id,
                                                modseq: messageData.modseq,
                                                unseen: messageData.unseen
                                            },
                                            () => {
                                                this.notifier.fire(mailboxData.user, mailboxData.path);
                                                return cleanup(null, true, {
                                                    uidValidity,
                                                    uid,
                                                    id: messageData._id,
                                                    mailbox: mailboxData._id,
                                                    status: 'new'
                                                });
                                            }
                                        );
                                    });
                                });
                            });
                        });
                    });
                }
            );
        });
    }

    checkExistingMessage(mailboxData, message, options, callback) {
        // if a similar message already exists then update existing one
        this.database.collection('messages').findOne({
            mailbox: mailboxData._id,
            hdate: message.hdate,
            msgid: message.msgid,
            uid: {
                $gt: 0,
                $lt: mailboxData.uidNext
            }
        }, (err, existing) => {
            if (err) {
                return callback(err);
            }

            if (!existing) {
                // nothing to do here, continue adding message
                return callback();
            }

            if (options.skipExisting) {
                // message already exists, just skip it
                return callback(null, true, {
                    uid: existing.uid,
                    id: existing._id,
                    mailbox: mailboxData._id,
                    status: 'skip'
                });
            }

            // As duplicate message was found, update UID, MODSEQ and FLAGS

            // acquire new UID+MODSEQ
            this.database.collection('mailboxes').findOneAndUpdate({
                _id: mailboxData._id
            }, {
                $inc: {
                    // allocate bot UID and MODSEQ values so when journal is later sorted by
                    // modseq then UIDs are always in ascending order
                    uidNext: 1,
                    modifyIndex: 1
                }
            }, {
                returnOriginal: true
            }, (err, item) => {
                if (err) {
                    return callback(err);
                }

                if (!item || !item.value) {
                    // was not able to acquire a lock
                    let err = new Error('Mailbox is missing');
                    err.imapResponse = 'TRYCREATE';
                    return callback(err);
                }

                let mailboxData = item.value;
                let uid = mailboxData.uidNext;
                let modseq = mailboxData.modifyIndex + 1;

                this.database.collection('messages').findOneAndUpdate({
                    _id: existing._id,
                    // hash key
                    mailbox: mailboxData._id,
                    uid: existing.uid
                }, {
                    $set: {
                        uid,
                        modseq,
                        flags: message.flags
                    }
                }, {
                    returnOriginal: false
                }, (err, item) => {
                    if (err) {
                        return callback(err);
                    }

                    if (!item || !item.value) {
                        // message was not found for whatever reason
                        return callback();
                    }

                    let updated = item.value;

                    if (options.session && options.session.selected && options.session.selected.mailbox === mailboxData.path) {
                        options.session.writeStream.write(options.session.formatResponse('EXPUNGE', existing.uid));
                    }

                    if (options.session && options.session.selected && options.session.selected.mailbox === mailboxData.path) {
                        options.session.writeStream.write(options.session.formatResponse('EXISTS', updated.uid));
                    }
                    this.notifier.addEntries(
                        mailboxData,
                        false,
                        {
                            command: 'EXPUNGE',
                            ignore: options.session && options.session.id,
                            uid: existing.uid,
                            message: existing._id,
                            unseen: existing.unseen
                        },
                        () => {
                            this.notifier.addEntries(
                                mailboxData,
                                false,
                                {
                                    command: 'EXISTS',
                                    uid: updated.uid,
                                    ignore: options.session && options.session.id,
                                    message: updated._id,
                                    modseq: updated.modseq,
                                    unseen: updated.unseen
                                },
                                () => {
                                    this.notifier.fire(mailboxData.user, mailboxData.path);
                                    return callback(null, true, {
                                        uidValidity: mailboxData.uidValidity,
                                        uid,
                                        id: existing._id,
                                        mailbox: mailboxData._id,
                                        status: 'update'
                                    });
                                }
                            );
                        }
                    );
                });
            });
        });
    }

    updateQuota(mailboxData, inc, callback) {
        inc = inc || {};

        this.users.collection('users').findOneAndUpdate(
            {
                _id: mailboxData.user
            },
            {
                $inc: {
                    storageUsed: Number(inc.storageUsed) || 0
                }
            },
            callback
        );
    }

    del(options, callback) {
        let message = options.message;
        this.getMailbox(
            options.mailbox || {
                mailbox: message.mailbox
            },
            (err, mailboxData) => {
                if (err) {
                    return callback(err);
                }

                this.database.collection('messages').deleteOne({
                    _id: message._id,
                    mailbox: mailboxData._id,
                    uid: message.uid
                }, err => {
                    if (err) {
                        return callback(err);
                    }

                    this.updateQuota(
                        mailboxData._id,
                        {
                            storageUsed: -message.size
                        },
                        () => {
                            let updateAttachments = next => {
                                let attachmentIds = Object.keys(message.mimeTree.attachmentMap || {}).map(key => message.mimeTree.attachmentMap[key]);
                                if (!attachmentIds.length) {
                                    return next();
                                }

                                this.attachmentStorage.deleteMany(attachmentIds, message.magic, next);
                            };

                            updateAttachments(() => {
                                if (options.session && options.session.selected && options.session.selected.mailbox === mailboxData.path) {
                                    options.session.writeStream.write(options.session.formatResponse('EXPUNGE', message.uid));
                                }

                                this.notifier.addEntries(
                                    mailboxData._id,
                                    false,
                                    {
                                        command: 'EXPUNGE',
                                        ignore: options.session && options.session.id,
                                        uid: message.uid,
                                        message: message._id,
                                        unseen: message.unseen
                                    },
                                    () => {
                                        this.notifier.fire(mailboxData.user, mailboxData.path);

                                        if (options.skipAttachments) {
                                            return callback(null, true);
                                        }

                                        return callback(null, true);
                                    }
                                );
                            });
                        }
                    );
                });
            }
        );
    }

    move(options, callback) {
        this.getMailbox(options.source, (err, mailboxData) => {
            if (err) {
                return callback(err);
            }

            this.getMailbox(options.destination, (err, target) => {
                if (err) {
                    return callback(err);
                }

                this.database.collection('mailboxes').findOneAndUpdate({
                    _id: mailboxData._id
                }, {
                    $inc: {
                        // increase the mailbox modification index
                        // to indicate that something happened
                        modifyIndex: 1
                    }
                }, {
                    uidNext: true
                }, () => {
                    let cursor = this.database
                        .collection('messages')
                        .find({
                            mailbox: mailboxData._id,
                            uid: options.messageQuery ? options.messageQuery : tools.checkRangeQuery(options.messages)
                        })
                        // ordering is needed for IMAP UIDPLUS results
                        .sort({ uid: 1 });

                    let sourceUid = [];
                    let destinationUid = [];

                    let removeEntries = [];
                    let existsEntries = [];

                    let done = err => {
                        let next = () => {
                            if (err) {
                                return callback(err);
                            }
                            return callback(null, true, {
                                uidValidity: target.uidValidity,
                                sourceUid,
                                destinationUid,
                                mailbox: mailboxData._id,
                                status: 'moved'
                            });
                        };

                        if (existsEntries.length) {
                            // mark messages as deleted from old mailbox
                            return this.notifier.addEntries(mailboxData, false, removeEntries, () => {
                                // mark messages as added to new mailbox
                                this.notifier.addEntries(target, false, existsEntries, () => {
                                    this.notifier.fire(mailboxData.user, mailboxData.path);
                                    this.notifier.fire(target.user, target.path);
                                    next();
                                });
                            });
                        }
                        next();
                    };

                    let processNext = () => {
                        cursor.next((err, message) => {
                            if (err) {
                                return done(err);
                            }
                            if (!message) {
                                return cursor.close(done);
                            }

                            let messageId = message._id;
                            let messageUid = message.uid;

                            if (options.returnIds) {
                                sourceUid.push(message._id);
                            } else {
                                sourceUid.push(messageUid);
                            }

                            this.database.collection('mailboxes').findOneAndUpdate({
                                _id: target._id
                            }, {
                                $inc: {
                                    uidNext: 1
                                }
                            }, {
                                uidNext: true
                            }, (err, item) => {
                                if (err) {
                                    return cursor.close(() => done(err));
                                }

                                if (!item || !item.value) {
                                    return cursor.close(() => done(new Error('Mailbox disappeared')));
                                }

                                message._id = new ObjectID();

                                let uidNext = item.value.uidNext;

                                if (options.returnIds) {
                                    destinationUid.push(message._id);
                                } else {
                                    destinationUid.push(uidNext);
                                }

                                // set new mailbox
                                message.mailbox = target._id;

                                // new mailbox means new UID
                                message.uid = uidNext;

                                // this will be changed later by the notification system
                                message.modseq = 0;

                                // retention settings
                                message.exp = !!target.retention;
                                message.rdate = Date.now() + (target.retention || 0);

                                let unseen = message.unseen;

                                if (['\\Junk', '\\Trash'].includes(target.specialUse) || !message.undeleted) {
                                    delete message.searchable;
                                } else {
                                    message.searchable = true;
                                }

                                let junk = false;
                                if (target.specialUse === '\\Junk' && !message.junk) {
                                    message.junk = true;
                                    junk = 1;
                                } else if (target.specialUse !== '\\Trash' && message.junk) {
                                    delete message.junk;
                                    junk = -1;
                                }

                                Object.keys(options.updates || []).forEach(key => {
                                    switch (key) {
                                        case 'seen':
                                        case 'deleted':
                                            {
                                                let fname = '\\' + key.charAt(0).toUpperCase() + key.substr(1);
                                                if (!options.updates[key] && !message.flags.includes(fname)) {
                                                    // add missing flag
                                                    message.flags.push(fname);
                                                } else if (options.updates[key] && message.flags.includes(fname)) {
                                                    // remove non-needed flag
                                                    let flags = new Set(message.flags);
                                                    flags.delete(fname);
                                                    message.flags = Array.from(flags);
                                                }
                                                message['un' + key] = options.updates[key];
                                            }
                                            break;
                                        case 'flagged':
                                        case 'draft':
                                            {
                                                let fname = '\\' + key.charAt(0).toUpperCase() + key.substr(1);
                                                if (options.updates[key] && !message.flags.includes(fname)) {
                                                    // add missing flag
                                                    message.flags.push(fname);
                                                } else if (!options.updates[key] && message.flags.includes(fname)) {
                                                    // remove non-needed flag
                                                    let flags = new Set(message.flags);
                                                    flags.delete(fname);
                                                    message.flags = Array.from(flags);
                                                }
                                                message[key] = options.updates[key];
                                            }
                                            break;
                                        case 'expires':
                                            {
                                                if (options.updates.expires) {
                                                    message.exp = true;
                                                    message.rdate = options.updates.expires.getTime();
                                                } else {
                                                    message.exp = false;
                                                }
                                            }
                                            break;
                                    }
                                });

                                if (options.markAsSeen) {
                                    message.unseen = false;
                                    if (!message.flags.includes('\\Seen')) {
                                        message.flags.push('\\Seen');
                                    }
                                }

                                this.database.collection('messages').insertOne(message, (err, r) => {
                                    if (err) {
                                        return cursor.close(() => done(err));
                                    }

                                    let insertId = r.insertedId;

                                    // delete old message
                                    this.database.collection('messages').deleteOne({
                                        _id: messageId,
                                        mailbox: mailboxData._id,
                                        uid: messageUid
                                    }, err => {
                                        if (err) {
                                            return cursor.close(() => done(err));
                                        }

                                        if (options.session) {
                                            options.session.writeStream.write(options.session.formatResponse('EXPUNGE', sourceUid));
                                        }

                                        removeEntries.push({
                                            command: 'EXPUNGE',
                                            ignore: options.session && options.session.id,
                                            uid: messageUid,
                                            message: messageId,
                                            unseen
                                        });

                                        let entry = {
                                            command: 'EXISTS',
                                            uid: uidNext,
                                            message: insertId,
                                            unseen: message.unseen
                                        };
                                        if (junk) {
                                            entry.junk = junk;
                                        }
                                        existsEntries.push(entry);

                                        if (existsEntries.length >= consts.BULK_BATCH_SIZE) {
                                            // mark messages as deleted from old mailbox
                                            return this.notifier.addEntries(mailboxData, false, removeEntries, () => {
                                                // mark messages as added to new mailbox
                                                this.notifier.addEntries(target, false, existsEntries, () => {
                                                    removeEntries = [];
                                                    existsEntries = [];
                                                    this.notifier.fire(mailboxData.user, mailboxData.path);
                                                    this.notifier.fire(target.user, target.path);
                                                    processNext();
                                                });
                                            });
                                        }
                                        processNext();
                                    });
                                });
                            });
                        });
                    };

                    processNext();
                });
            });
        });
    }

    generateIndexedHeaders(headersArray, options) {
        // allow configuring extra header keys that are indexed
        let indexedHeaders = options && options.indexedHeaders;
        return (headersArray || [])
            .map(line => {
                line = Buffer.from(line, 'binary').toString();

                let key = line
                    .substr(0, line.indexOf(':'))
                    .trim()
                    .toLowerCase();

                if (!INDEXED_HEADERS.includes(key) && (!indexedHeaders || !indexedHeaders.includes(key))) {
                    // do not index this header
                    return false;
                }

                let value = line
                    .substr(line.indexOf(':') + 1)
                    .trim()
                    .replace(/\s*\r?\n\s*/g, ' ');

                try {
                    value = libmime.decodeWords(value);
                } catch (E) {
                    // ignore
                }

                // store indexed value as lowercase for easier SEARCHing
                value = value.toLowerCase();

                // trim long values as mongodb indexed fields can not be too long
                if (Buffer.byteLength(key, 'utf-8') >= 255) {
                    key = Buffer.from(key)
                        .slice(0, 255)
                        .toString();
                    key = key.substr(0, key.length - 4);
                }

                if (Buffer.byteLength(value, 'utf-8') >= 880) {
                    // value exceeds MongoDB max indexed value length
                    value = Buffer.from(value)
                        .slice(0, 880)
                        .toString();
                    // remove last 4 chars to be sure we do not have any incomplete unicode sequences
                    value = value.substr(0, value.length - 4);
                }

                return {
                    key,
                    value
                };
            })
            .filter(line => line);
    }

    prepareMessage(options) {
        let id = new ObjectID();

        let mimeTree = this.indexer.parseMimeTree(options.raw);

        let size = this.indexer.getSize(mimeTree);
        let bodystructure = this.indexer.getBodyStructure(mimeTree);
        let envelope = this.indexer.getEnvelope(mimeTree);

        let idate = (options.date && parseDate(options.date)) || new Date();
        let hdate = (mimeTree.parsedHeader.date && parseDate([].concat(mimeTree.parsedHeader.date || []).pop() || '', idate)) || false;

        let subject = ([].concat(mimeTree.parsedHeader.subject || []).pop() || '').trim();
        try {
            subject = libmime.decodeWords(subject);
        } catch (E) {
            // ignore
        }
        subject = this.normalizeSubject(subject);

        let flags = [].concat(options.flags || []);

        if (!hdate || hdate.toString() === 'Invalid Date') {
            hdate = idate;
        }

        let msgid = envelope[9] || '<' + uuidV1() + '@wildduck.email>';

        let headers = this.generateIndexedHeaders(mimeTree.header, options);

        return {
            id,
            mimeTree,
            size,
            bodystructure,
            envelope,
            idate,
            hdate,
            flags,
            msgid,
            headers,
            subject
        };
    }

    // resolves or generates new thread id for a message
    getThreadId(userId, subject, mimeTree, callback) {
        let referenceIds = new Set(
            [
                [].concat(mimeTree.parsedHeader['message-id'] || []).pop() || '',
                [].concat(mimeTree.parsedHeader['in-reply-to'] || []).pop() || '',
                ([].concat(mimeTree.parsedHeader['thread-index'] || []).pop() || '').substr(0, 22),
                [].concat(mimeTree.parsedHeader.references || []).pop() || ''
            ]
                .join(' ')
                .split(/\s+/)
                .map(id => id.replace(/[<>]/g, '').trim())
                .filter(id => id)
                .map(id =>
                    crypto
                        .createHash('sha1')
                        .update(id)
                        .digest('base64')
                        .replace(/[=]+$/g, '')
                )
        );

        referenceIds = Array.from(referenceIds).slice(0, 10);

        // most messages are not threaded, so an upsert call should be ok to make
        this.database.collection('threads').findOneAndUpdate({
            user: userId,
            ids: { $in: referenceIds },
            subject
        }, {
            $addToSet: {
                ids: { $each: referenceIds }
            },
            $set: {
                updated: new Date()
            }
        }, {
            returnOriginal: false
        }, (err, r) => {
            if (err) {
                return callback(err);
            }
            if (r.value) {
                return callback(null, r.value._id);
            }
            // thread not found, create a new one
            this.database.collection('threads').insertOne({
                user: userId,
                subject,
                ids: referenceIds,
                updated: new Date()
            }, (err, r) => {
                if (err) {
                    return callback(err);
                }
                return callback(null, r.insertedId);
            });
        });
    }

    normalizeSubject(subject) {
        subject = subject.replace(/\s+/g, ' ');

        let match = true;
        while (match) {
            match = false;
            subject = subject
                .replace(/^(re|fwd?)\s*:|\s*\(fwd\)\s*$/gi, () => {
                    match = true;
                    return '';
                })
                .trim();
        }

        return subject;
    }

    update(user, mailbox, messageQuery, changes, callback) {
        let updates = { $set: {} };
        let update = false;
        let addFlags = [];
        let removeFlags = [];

        let notifyEntries = [];

        Object.keys(changes || {}).forEach(key => {
            switch (key) {
                case 'seen':
                    updates.$set.unseen = !changes.seen;
                    if (changes.seen) {
                        addFlags.push('\\Seen');
                    } else {
                        removeFlags.push('\\Seen');
                    }
                    update = true;
                    break;

                case 'deleted':
                    updates.$set.undeleted = !changes.deleted;
                    if (changes.deleted) {
                        addFlags.push('\\Deleted');
                    } else {
                        removeFlags.push('\\Deleted');
                    }
                    update = true;
                    break;

                case 'flagged':
                    updates.$set.flagged = changes.flagged;
                    if (changes.flagged) {
                        addFlags.push('\\Flagged');
                    } else {
                        removeFlags.push('\\Flagged');
                    }
                    update = true;
                    break;

                case 'draft':
                    updates.$set.flagged = changes.draft;
                    if (changes.draft) {
                        addFlags.push('\\Draft');
                    } else {
                        removeFlags.push('\\Draft');
                    }
                    update = true;
                    break;

                case 'expires':
                    if (changes.expires) {
                        updates.$set.exp = true;
                        updates.$set.rdate = changes.expires.getTime();
                    } else {
                        updates.$set.exp = false;
                    }
                    update = true;
                    break;
            }
        });

        if (!update) {
            return callback(new Error('Nothing was changed'));
        }

        if (addFlags.length) {
            if (!updates.$addToSet) {
                updates.$addToSet = {};
            }
            updates.$addToSet.flags = { $each: addFlags };
        }

        if (removeFlags.length) {
            if (!updates.$pull) {
                updates.$pull = {};
            }
            updates.$pull.flags = { $in: removeFlags };
        }

        // acquire new MODSEQ
        this.database.collection('mailboxes').findOneAndUpdate({
            _id: mailbox,
            user
        }, {
            $inc: {
                // allocate new MODSEQ value
                modifyIndex: 1
            }
        }, {
            returnOriginal: false
        }, (err, item) => {
            if (err) {
                return callback(err);
            }

            if (!item || !item.value) {
                return callback(new Error('Mailbox is missing'));
            }

            let mailboxData = item.value;

            updates.$set.modseq = mailboxData.modifyIndex;

            let updatedCount = 0;
            let cursor = this.database
                .collection('messages')
                .find({
                    mailbox: mailboxData._id,
                    uid: messageQuery
                })
                .project({
                    _id: true,
                    uid: true
                });

            let done = err => {
                let next = () => {
                    if (err) {
                        return callback(err);
                    }
                    return callback(null, updatedCount);
                };

                if (notifyEntries.length) {
                    return this.notifier.addEntries(mailboxData, false, notifyEntries, () => {
                        notifyEntries = [];
                        this.notifier.fire(mailboxData.user, mailboxData.path);
                        next();
                    });
                }
                next();
            };

            let processNext = () => {
                cursor.next((err, messageData) => {
                    if (err) {
                        return done(err);
                    }

                    if (!messageData) {
                        return cursor.close(done);
                    }

                    this.database.collection('messages').findOneAndUpdate({
                        _id: messageData._id,
                        // hash key
                        mailbox,
                        uid: messageData.uid
                    }, updates, {
                        projection: {
                            _id: true,
                            uid: true,
                            flags: true
                        }
                    }, (err, item) => {
                        if (err) {
                            return cursor.close(() => done(err));
                        }

                        if (!item || !item.value) {
                            return processNext();
                        }

                        let messageData = item.value;
                        updatedCount++;

                        notifyEntries.push({
                            command: 'FETCH',
                            uid: messageData.uid,
                            flags: messageData.flags,
                            message: messageData._id,
                            unseenChange: !!changes.seen
                        });

                        if (notifyEntries.length >= consts.BULK_BATCH_SIZE) {
                            return this.notifier.addEntries(mailboxData, false, notifyEntries, () => {
                                notifyEntries = [];
                                this.notifier.fire(mailboxData.user, mailboxData.path);
                                processNext();
                            });
                        }
                        processNext();
                    });
                });
            };

            processNext();
        });
    }

    encryptMessage(pubKey, raw, callback) {
        if (!pubKey) {
            return callback(null, false);
        }

        let lastBytes = [];
        let headerEnd = raw.length;
        let headerLength = 0;

        // split the message into header and body
        for (let i = 0, len = raw.length; i < len; i++) {
            lastBytes.unshift(raw[i]);
            if (lastBytes.length > 10) {
                lastBytes.length = 4;
            }
            if (lastBytes.length < 2) {
                continue;
            }
            let pos = 0;
            if (lastBytes[pos] !== 0x0a) {
                continue;
            }
            pos++;
            if (lastBytes[pos] === 0x0d) {
                pos++;
            }
            if (lastBytes[pos] !== 0x0a) {
                continue;
            }
            pos++;
            if (lastBytes[pos] === 0x0d) {
                pos++;
            }
            // we have a match!'
            headerEnd = i + 1 - pos;
            headerLength = pos;
            break;
        }

        let header = raw.slice(0, headerEnd);
        let breaker = headerLength ? raw.slice(headerEnd, headerEnd + headerLength) : new Buffer(0);
        let body = headerEnd + headerLength < raw.length ? raw.slice(headerEnd + headerLength) : new Buffer(0);

        // modify headers
        let headers = [];
        let bodyHeaders = [];
        let lastHeader = false;
        let boundary = 'nm_' + crypto.randomBytes(14).toString('hex');

        let headerLines = header.toString('binary').split('\r\n');
        // use for, so we could escape from it if needed
        for (let i = 0, len = headerLines.length; i < len; i++) {
            let line = headerLines[i];
            if (!i || !lastHeader || !/^\s/.test(line)) {
                lastHeader = [line];
                if (/^content-type:/i.test(line)) {
                    let parts = line.split(':');
                    let value = parts.slice(1).join(':');
                    if (
                        value
                            .split(';')
                            .shift()
                            .trim()
                            .toLowerCase() === 'multipart/encrypted'
                    ) {
                        // message is already encrypted, do nothing
                        return callback(null, false);
                    }
                    bodyHeaders.push(lastHeader);
                } else if (/^content-transfer-encoding:/i.test(line)) {
                    bodyHeaders.push(lastHeader);
                } else {
                    headers.push(lastHeader);
                }
            } else {
                lastHeader.push(line);
            }
        }

        headers.push(['Content-Type: multipart/encrypted; protocol="application/pgp-encrypted";'], [' boundary="' + boundary + '"']);

        headers.push(['Content-Description: OpenPGP encrypted message']);
        headers.push(['Content-Transfer-Encoding: 7bit']);

        headers = Buffer.from(headers.map(line => line.join('\r\n')).join('\r\n'), 'binary');
        bodyHeaders = Buffer.from(bodyHeaders.map(line => line.join('\r\n')).join('\r\n'), 'binary');

        openpgp
            .encrypt({
                data: Buffer.concat([Buffer.from(bodyHeaders + '\r\n\r\n'), body]),
                publicKeys: openpgp.key.readArmored(pubKey).keys
            })
            .then(ciphertext => {
                let text =
                    'This is an OpenPGP/MIME encrypted message\r\n\r\n' +
                    '--' +
                    boundary +
                    '\r\n' +
                    'Content-Type: application/pgp-encrypted\r\n' +
                    'Content-Transfer-Encoding: 7bit\r\n' +
                    '\r\n' +
                    'Version: 1\r\n' +
                    '\r\n' +
                    '--' +
                    boundary +
                    '\r\n' +
                    'Content-Type: application/octet-stream; name=encrypted.asc\r\n' +
                    'Content-Disposition: inline; filename=encrypted.asc\r\n' +
                    'Content-Transfer-Encoding: 7bit\r\n' +
                    '\r\n' +
                    ciphertext.data +
                    '\r\n--' +
                    boundary +
                    '--\r\n';

                callback(null, Buffer.concat([headers, breaker, Buffer.from(text)]));
            })
            .catch(err => {
                if (err) {
                    // ignore
                }
                // encryption failed, keep message as is
                callback(null, false);
            });
    }
}

module.exports = MessageHandler;
