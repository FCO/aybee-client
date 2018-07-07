const fetch     = require("node-fetch")
const murmur    = require("murmurhash")

const query = `query TokenById($token: UUID!) {
    tokenById(id: $token) {
        config {
            nodes {
                track
                salt
                identifier
                experiment
                variant
                percent
                variables
                ranges {
                    start {
                        value
                        inclusive
                    }
                    end {
                        value
                        inclusive
                    }
                }
            }
        }
    }
}
`
const util = require("util")
const idsProxy = {
    get(target, name) {
        if (typeof(name) != "string" || name == util.inspect.custom || name == 'inspect' || name == 'valueOf' ) return;
        if(!target.possibleIds.has(name)) return console.warn(`id "${name}" is not registred`)
        return target._idsValues[name]
    },
    set(target, name, value) {
        if (typeof(name) != "string" || name == util.inspect.custom || name == 'inspect' || name == 'valueOf' ) return;
        if(!target.possibleIds.has(name)) return console.warn(`id "${name}" is not registred`)
        target._expBySalt[name].forEach(exp => delete target[exp])
        target._idsValues[name] = value
        TRACK: for(let salt in target._conf[name] || {}) {
            const hash = murmur.v3(`${salt} - ${name}:${value}`) / 0xffffffff
            for(let variant of target._conf[name][salt]) {
                for(let range of variant.range) {
                    if(hash >= range.start.value && hash < range.end.value) {
                        target.experiments[variant.experiment] = variant.variant
                        continue TRACK
                    }
                }
            }
        }
        return true
    },
}

class AyBee {
    constructor(token, url = "http://127.0.0.1:5000/graphql") {
        this.token          = token
        this.url            = url
        this.ids            = new Proxy(this, idsProxy)
        this.possibleIds    = new Set()
        this._idsValues     = {}
        this.experiments    = {}
        this._expBySalt     = {}
        this.vars           = {}
        this._conf          = {}
    }

    fetchConfig() {
        return fetch(this.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept':       'application/json',
            },
            body: JSON.stringify({
                query,
                variables: { token: this.token },
            })
        })
            .then(r => r.json())
            .then(d => d.data.tokenById.config.nodes)
            .then(conf => {
                conf.forEach(c => {
                    this.possibleIds = new Set([ ...this.possibleIds, c.identifier ])
                    this._expBySalt = {
                        ...this._expBySalt,
                        [c.identifier]: new Set([
                            ...(this._expBySalt[c.identifier] || []),
                            c.experiment
                        ])
                    }
                    this._conf = {
                        ...this._conf,
                        [c.identifier]: {
                            ...(this._conf[c.identifier] || {}),
                            [c.salt]: [
                                ...((this._conf[c.identifier] || {[c.salt]: []})[c.salt] || []),
                                {
                                    range:      c.ranges,
                                    variant:    c.variant,
                                    experiment: c.experiment,
                                }
                            ]
                        }
                    }
                })
            })
    }
}

AyBee.config = async token => {
    if(AyBee.instance == null) AyBee.instance = {}
    AyBee.instance[token] = new AyBee(token)
    await AyBee.instance[token].fetchConfig()
    return AyBee.instance[token]
}

module.exports = AyBee
