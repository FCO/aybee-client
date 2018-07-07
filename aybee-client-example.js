(async () => {
    const AyBee = require(".")
    const ayBee = await AyBee.config("b12458b6-815a-11e8-ba08-83307a5aa975")

    ayBee.ids.accountId = 123                           // warns if accountId is not registred
    ayBee.ids.requestId = 123                           // warns if requestId is not registred

    console.log(Object.keys(ayBee.experiments))         // get all participants experiment names
    if("exp 001" in ayBee.experiments) {                // if it's participating of experiment exp123
        console.log(`Exp: exp 001`)
        console.log(
            `Variant ${ayBee.experiments["exp 001"]}`   // get the variant
        )
    }

    const {
        bla,
        ble,
        bli                = 42,
        blo                = 13,
        blu: anotherVar    = 3.14
    } = ayBee.vars                                      // get variables defined by variants
    console.log({bla, ble, bli, blo, anotherVar})

    ayBee.metrics.productVisualized({product: 123})     // send metrics
})()
