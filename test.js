const throttle = require('.')();



let actor = {


    id: 14324,
    bucket: {
        tokens: 2,
        window: '20s',
        // backoffTime: '20s'
    }
}


let ts = throttle.namespace('hopspell')

setInterval(() => {

    ts.actor(actor)
        .bucket(10, '20s')
        .consume(1)
        .then((status) => {
            console.log(status)
        })
        .catch((err) => {
            //Throw your error
            console.log(err);
        })

    return
    ts.actor('actor')
        .bucket(10, '20s')
        .consume(1)
        .then((status) => {
            console.log(status)
        })
        .catch((err) => {
            //Throw your error
            console.log(err);
        })


}, 1000);


setInterval(() => {
    // throttle.reset(actor)
}, 3000);