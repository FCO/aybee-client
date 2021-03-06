require('es6-promise').polyfill();
require('isomorphic-fetch');
const murmur    = require("murmurhash")
const deepmerge = require("deepmerge")
const Influx    = require("influx")
const os        = require('os')
const util      = require("util")
const uuidv4    = require('uuid/v4');
const { Pool }  = require('pg')

const query = `query TokenById($token: UUID!) {
    tokenById(id: $token) {
        metricType {
          nodes {
            name
          }
        }
        metricConfig {
            metricStorage
            conf
        }
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

const idsProxy = {
    get(target, name) {
        if (typeof(name) != "string" || name == util.inspect.custom || name == 'inspect' || name == 'valueOf' ) return;
        if(!target.possibleIds.has(name)) return console.warn(new Error(`id "${name}" is not registred`))
        return target._idsValues[name]
    },
    set(target, name, value) {
        if (typeof(name) != "string" || name == util.inspect.custom || name == 'inspect' || name == 'valueOf' ) return;
        if(!target.possibleIds.has(name)) {
            console.warn(new Error(`id "${name}" is not registred`))
            return false
        }
        target.newSession()
        target._expBySalt[name].forEach(exp => delete target[exp])
        target._idsValues[name] = value
        TRACK: for(let salt in target._conf[name] || {}) {
            const hash = murmur.v3(`${salt} - ${name}:${value}`) / 0xffffffff
            for(let variant of target._conf[name][salt]) {
                for(let range of variant.range) {
                    if(hash >= range.start.value && hash < range.end.value) {
                        if(variant.variant)
                            target.experiments[variant.experiment] = variant.variant
                        continue TRACK
                    }
                }
            }
        }
        return true
    },
}

const metricsProxy = {
    get(target, name) {
        if (typeof(name) != "string" || name == util.inspect.custom || name == 'inspect' || name == 'valueOf' ) return;
        if(!target.possibleMetrics.has(name)) console.warn(`Metric "${name}" is not registred`)
        return data => {
            target.sendMetric(name, data)
        }
    },
}

class AyBee {
    constructor(token, url = "http://127.0.0.1:5000/graphql") {
        this.token              = token
        this.url                = url
        this.ids                = new Proxy(this, idsProxy)
        this.possibleIds        = new Set()
        this.metrics            = new Proxy(this, metricsProxy)
        this.possibleMetrics    = new Set()
        this._idsValues         = {}
        this.experiments        = {}
        this._expBySalt         = {}
        this._conf              = {}
        this._varsByExpVar      = {}
        this._vars              = null
        this.newSession()
    }

    newSession() {
        this.sessionId = uuidv4()
        this._vars = null
    }

    get vars() {
        let vars = {}
        if(this._vars !== null) return this._vars
        for(let exp in this.experiments) {
            vars = deepmerge(vars, this._varsByExpVar[exp][this.experiments[exp]] || {})
        }
        return vars
    }

    async fetchConfig() {
        const resp = await fetch(this.url, {
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
        const body = await resp.json()
        console.log(body)
        if(body.data.tokenById === null) {
            throw "Invalid Token!!!"
        }
        this.possibleMetrics    = new Set(body.data.tokenById.metricType.nodes.map(type => type.name))
        const metricConf        = body.data.tokenById.metricConfig;
        this._metricStorage     = metricConf.metricStorage.toUpperCase()
        this._metric            = AyBee.createMetricStorage[this._metricStorage](metricConf.conf)
        const conf              = body.data.tokenById.config.nodes
        conf.forEach(c => {
            this.possibleIds = new Set([ ...this.possibleIds, c.identifier ])
            this._varsByExpVar = {
                ...this._varsByExpVar,
                [c.experiment]: {
                    ...(this._varsByExpVar[c.experiment] || {}),
                    [c.variant]: c.variables
                }
            }
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
    }

    sendMetric(metric, data = {}) {
        return AyBee.sendMetric[this._metricStorage]({
            metric,
            data,
            metricObj:      this._metric,
            experiments:    this.experiments,
            sessionId:      this.sessionId
        })
    }
}

AyBee.createMetricStorage = {
    INFLUXDB:   conf => new Influx.InfluxDB(conf),
    POSTGRESQL: conf => new Pool(conf),
}

AyBee.sendMetric = {
    INFLUXDB: async ({ metric, metricObj, experiments = {}, sessionId = "", data = {} } = {}) => {
        const toSend = {
            measurement: "metrics",
            tags: {
                ...experiments,
                metric
            },
            fields: {
                sessionId,
                ...data,
                metric,
                host:       os.hostname(),
            },
        }
        return await metricObj.writePoints([ toSend ])
    },
    POSTGRESQL: async ({ metric, metricObj, experiments = {}, sessionId = "", data = {} } = {}) => {
        const exp = { ...experiments, "": "" }
        await Promise.all(Object.keys(exp).map(xp => metricObj.query(
            "insert into aybee_metrics.metric(metric, session_id, experiment, variant, data) values($1, $2, $3, $4, $5) returning *;",
            [metric, sessionId, xp, exp[xp], data]
        )))
    },
}

AyBee.config = async token => {
    if(AyBee.instance == null) AyBee.instance = {}
    AyBee.instance[token] = new AyBee(token)
    await AyBee.instance[token].fetchConfig()
    return AyBee.instance[token]
}

module.exports = AyBee
