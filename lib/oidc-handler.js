'use strict';

const { createVerifier } = require('fast-jwt');
const config = require('wild-config');


class OIDCHandler {

    constructor(options) {
        this.users = options.users || options.database;
        this.cache = options?.cache || config.oidc.cache
        this.init();
    }


    init(){
        this.verifyAsync  = createVerifier({ 
            key: async () => config.oidc.ssokey,
            cache: 100,
            algorithms:['RS256','HS256'],
            ignoreExpiration:false,
            requiredClaims: undefined,
            cacheTTL: 600000, 
            clockTolerance: 0, 
            errorCacheTTL: -1
        });
    }

    async verify(token){
        const payload = await this.verifyAsync(token)

        return payload
    }

}


module.exports = OIDCHandler;