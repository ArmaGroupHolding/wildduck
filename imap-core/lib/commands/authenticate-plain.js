'use strict';

module.exports = {
    state: 'Not Authenticated',

    schema: [
        {
            name: 'token',
            type: 'string',
            optional: true
        }
    ],

    handler(command, callback, next) {
        let token = ((command.attributes && command.attributes[0] && command.attributes[0].value) || '').toString().trim();

        if (!this.secure && !this._server.options.disableSTARTTLS && !this._server.options.ignoreSTARTTLS) {
            // Only allow authentication using TLS
            return callback(null, {
                response: 'BAD',
                message: 'Run STARTTLS first'
            });
        }

        // Check if authentication method is set
        if (typeof this._server.onAuth !== 'function') {
            return callback(null, {
                response: 'NO',
                message: 'Authentication not implemented'
            });
        }

        if (!token) {
            this._nextHandler = (token, next) => {
                this._nextHandler = false;
                next(); // keep the parser flowing
                authenticate(this, token, callback);
            };
            this.send('+');
            return next(); // resume input parser. Normally this is done by callback() but we need the next input sooner
        }

        authenticate(this, token, callback);
    }
};

function authenticate(connection, token, callback) {
    let data = new Buffer(token, 'base64').toString().split('\x00');

    if (data.length !== 3) {
        return callback(null, {
            response: 'BAD',
            message: 'Invalid SASL argument'
        });
    }

    let username = (data[1] || '').toString().trim();
    let password = (data[2] || '').toString().trim();

    // Do auth
    connection._server.onAuth(
        {
            method: 'PLAIN',
            username,
            password
        },
        connection.session,
        (err, response) => {
            if (err) {
                connection._server.logger.info(
                    {
                        err,
                        tnx: 'auth',
                        username,
                        method: 'PLAIN',
                        action: 'fail',
                        cid: connection.id
                    },
                    '[%s] Authentication error for %s using %s\n%s',
                    connection.id,
                    username,
                    'PLAIN',
                    err.message
                );
                return callback(err);
            }

            if (!response || !response.user) {
                connection._server.logger.info(
                    {
                        tnx: 'auth',
                        username,
                        method: 'PLAIN',
                        action: 'fail',
                        cid: connection.id
                    },
                    '[%s] Authentication failed for %s using %s',
                    connection.id,
                    username,
                    'PLAIN'
                );
                return callback(null, {
                    response: 'NO',
                    code: 'AUTHENTICATIONFAILED',
                    message: 'Invalid credentials'
                });
            }

            connection._server.logger.info(
                {
                    tnx: 'auth',
                    username,
                    method: 'PLAIN',
                    action: 'success',
                    cid: connection.id
                },
                '[%s] %s authenticated using %s',
                connection.id,
                username,
                'PLAIN'
            );
            connection.session.user = response.user;
            connection.state = 'Authenticated';

            callback(null, {
                response: 'OK',
                message: new Buffer(username + ' authenticated').toString('binary')
            });
        }
    );
}
