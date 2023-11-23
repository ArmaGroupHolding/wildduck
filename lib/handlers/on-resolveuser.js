'use strict';

const db = require('../db');
const tools = require('../tools');
const consts = require('../consts');

// LSUB "" "*"
// Returns all subscribed folders, query is informational
// folders is either an Array or a Map

async function resolveHandler(username){
    try {
        let userData;
        let unameview = '';
        if (username.includes('@')) {
            unameview = tools.normalizeAddress(username, false, {
                removeLabel: true,
                removeDots: true
            });
        } else {
            unameview = username.replace(/\./g, '');
        }

        userData = await db.users.collection('users').findOne(
            {
                unameview
            },
            {
                projection: {
                    _id: true
                }
            }
        );
        return userData;
    } catch (err) {
        res.status(500);
        return res.json({
            error: 'MongoDB Error: ' + err.message,
            code: 'InternalDatabaseError'
        });
    }
}

module.exports = resolveHandler