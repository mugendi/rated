const Redis = require("ioredis"),
    util = require('util'),
    ms = require('ms'),
    moment = require('moment'),
    pkg = require('./package.json');



class Throttle {

    constructor(options) {

        options = Object.assign({ limit: 1000, window: '1m' }, options)

        if (!options || !options.redis || (options.redis instanceof Redis) === false) {;
            this.redis = new Redis();
        } else {
            this.redis = options.redis;
        }

        if (options.limit) {
            this.limit = options.limit;
        }

        if (options.window) {
            this.window = options.window;
        }

    }

    async quit() {
        await this.redis.quit();
    }

    make_actor_id(value) {

        let self = this;

        let bucket = {},
            cloned_val;


        if ("object" == typeof value) {

            cloned_val = Object.assign({}, value)

            // console.log(value);

            //if bucket is entered with actor data
            if (value.bucket) {
                if (value.bucket.tokens && "number" == typeof value.bucket.tokens) {
                    bucket.tokens = value.bucket.tokens;
                }

                let window;
                if (value.bucket.window && (window = to_ms(value.bucket.window))) {
                    bucket.window = window;
                }

                let backoffTime;
                if (value.bucket.backoffTime && (backoffTime = to_ms(value.bucket.backoffTime))) {
                    bucket.backoffTime = backoffTime;
                }

            }

            // remove bucket key
            delete cloned_val.bucket;

        } else {
            cloned_val = "" + value;
        }

        let resp = {
            id: unique(util.inspect(cloned_val)),
            bucket
        }

        return resp;

    }

    redis_vals(str = null) {
        let self = this;

        return {
            key: `${pkg.name}:${str||this.ns}`,
            totalTokensField: `${self.id}:l`,
            remainingTokensField: `${self.id}:r`,
            windowField: `${self.id}:w`,
            windowValField: `${self.id}:w-s`,
        }
    }


    namespace(name) {
        if ('string' !== typeof name) throw new Error("Namespace must be a string.")

        let self = this;

        self.ns = name;

        return self;
    }

    clone_context(id, bucket) {
        let self = this;

        let that = {
            id,
            bucket,
            ns: self.ns
        }

        let context = {}

        context.consume = self.consume.bind(Object.assign(Object.assign({}, that), {
            redis: self.redis,
            redis_vals: self.redis_vals.bind(Object.assign({}, that))
        }));

        that.consume = context.consume;
        context.bucket = self.bucket.bind(that);


        return context;
    }

    actor(value) {
        let self = this;

        let { id, bucket } = self.make_actor_id(value);

        let clone = self.clone_context(id, bucket);


        return clone;
    }

    bucket(tokens, window, backoffTime) {
        let self = this;

        if ("number" !== typeof tokens) throw new Error("Limit value must be entered and must be a number!");

        self.bucket.tokens = tokens;

        // console.log({ window });
        if (window && (window = to_ms(window))) {
            self.bucket.window = window;
        }

        if (backoffTime && (backoffTime = to_ms(backoffTime))) {
            self.bucket.backoffTime = backoffTime;
        }


        return self;

    }


    async reset(value) {

        let self = this;

        let { id, bucket } = self.make_actor_id(value);

        let {
            key,
            windowField,
        } = self.redis_vals.apply({ id, ns: self.ns })

        // to reset simply reset the window field to force window expiry
        return self.redis.hmset(key, windowField, 0)
            .then((resp) => {
                return {
                    id,
                    message: "Reset"
                }
            })
    }

    consume(tokens = 1) {
        let self = this;

        if (!self.bucket.tokens) throw new Error(`You cant start consuming without setting limit.`);

        return new Promise(async(resolve, reject) => {

            // First get/check values
            let {
                key,
                totalTokensField,
                remainingTokensField,
                windowField,
                windowValField
            } = self.redis_vals(),

                expires = 0,
                now = 0,
                status,
                tokenChange = -1 * tokens;


            // console.log({ key });
            let { token, limit, window, windowVal } = await self.redis.hmget(key, remainingTokensField, totalTokensField, windowField, windowValField)
                .then((resp) => {
                    return {
                        token: resp[0] ? Number(resp[0]) : null,
                        limit: resp[1] ? Number(resp[1]) : null,
                        window: resp[2] ? Number(resp[2]) : null,
                        windowVal: resp[3] ? Number(resp[3]) : null,
                    }
                })
                .catch(console.error)

            // calculate when current window expires
            now = moment().valueOf()
            expires = window - now;

            status = {
                identity: {
                    namespace: self.ns,
                    actor_id: self.id,
                },
                tokens: {
                    total: limit,
                    remaining: token
                },
                window: {
                    expires,
                    expiresAfter: ms_to_str(expires)
                }
            }

            //Reset Values if
            if (
                // Limit not se. This means we this hash field does not exist. i.e is new/fresh
                limit === null ||
                // If window period has expired
                expires <= 0 ||
                // if limit has changed
                limit !== self.bucket.tokens ||
                // if window duration has changed
                windowVal !== self.bucket.window
            ) {

                let windowStr = self.bucket.window || '1m',
                    // use ms ti handle all time formats
                    windowMs = to_ms(windowStr),
                    // use moment to set window expiry into the future
                    windowArr = ms(windowMs, { long: true }).split(' '),
                    windowTime = moment().add(...windowArr).valueOf()

                // console.log({ windowStr, windowMs, windowArr, windowTime });
                // console.log(windowTime - moment().valueOf());

                status.tokens.total = self.bucket.tokens;
                return self.redis.hset(key, totalTokensField, self.bucket.tokens)
                    .then((resp) => {
                        status.tokens.remaining = self.bucket.tokens;
                        return self.redis.hset(key, remainingTokensField, self.bucket.tokens)
                    })
                    .then((resp) => {
                        status.window.expires = windowMs;
                        return self.redis.hset(key, windowField, windowTime)
                    })
                    .then((resp) => {
                        return self.redis.hset(key, windowValField, self.bucket.window)
                    })
                    .then((resp) => {
                        status.window.reset = true;
                        resolve(status)
                    })
                    .catch(console.error)

            }

            // check that token is not zero
            if (token <= 0) {
                // console.log(limit);
                return self.redis.hincrby(key, remainingTokensField, tokenChange)
                    .then((tokens) => {

                        if (self.bucket.backoffTime) {
                            // console.log("DDDDDD");
                            // If user is continuing to exceed limits,
                            // increase window by value of backoffTime 
                            let backoffTimeStr = self.bucket.backoffTime,
                                backoffTimeVal = to_ms(backoffTimeStr),
                                backoffTimeMs = Math.abs(backoffTimeVal * tokens),
                                newWindowTime = moment(window).add(backoffTimeMs, 'milliseconds').valueOf()

                            console.log({ token, window, newWindowTime, backoffTimeStr, backoffTimeVal, backoffTimeMs })

                            status.window.backOffApplied = ms_to_str(backoffTimeMs);
                            return self.redis.hset(key, windowField, newWindowTime)

                        }

                        // Indicate that we have an excess
                        status.tokens.excess = Math.abs(tokens);

                    })
                    .then((resp) => {

                        reject(Object.assign({
                            error: new Error("Rate Limit Exceeded!")
                        }, { status }));

                    })
                    .catch(console.error)
                    // return 
            } else {
                // Take
                return self.redis.hincrby(key, remainingTokensField, tokenChange)
                    .then((resp) => {
                        // console.log({ resp });
                        status.tokens.remaining = resp;
                        resolve(status)
                    })
                    .catch(console.error)
            }

        });


    }


}

function ms_to_str(val) {

    let tempTime = moment.duration(val),
        timeObj = {
            years: tempTime.years(),
            months: tempTime.months(),
            days: tempTime.days(),
            hrs: tempTime.hours(),
            mins: tempTime.minutes(),
            secs: tempTime.seconds(),
            ms: tempTime.milliseconds()
        },

        timeArr = [];

    for (let k in timeObj) {
        if (Number(timeObj[k]) > 0) {
            timeArr.push(`${timeObj[k]} ${k}`)
        }
    }

    return timeArr.join(', ');
}

function to_ms(val) {
    return /[a-z]/i.test(val) ? ms(val) : Number(val)
}

/**
 * why choose 61 binary, because we need the last element char to replace the minus sign
 * eg: -aGtzd will be ZaGtzd
 */
function unique(text) {
    var id = binaryTransfer(bitwise(text), 61);
    return id.replace('-', 'Z');
}

// refer to: http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
function bitwise(str) {
    var hash = 0;
    if (str.length == 0) return hash;
    for (var i = 0; i < str.length; i++) {
        var ch = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + ch;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

// convert 10 binary to customized binary, max is 62
function binaryTransfer(integer, binary) {
    binary = binary || 62;
    var stack = [];
    var num;
    var result = '';
    var sign = integer < 0 ? '-' : '';

    function table(num) {
        var t = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        return t[num];
    }

    integer = Math.abs(integer);

    while (integer >= binary) {
        num = integer % binary;
        integer = Math.floor(integer / binary);
        stack.push(table(num));
    }

    if (integer > 0) {
        stack.push(table(integer));
    }

    for (var i = stack.length - 1; i >= 0; i--) {
        result += stack[i];
    }

    return sign + result;
}


module.exports = function(opts = {}) {
    return new Throttle(opts)
}