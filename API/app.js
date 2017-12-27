/**
 * Copyright 2017 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
'use strict';
var cfenv = require('cfenv');
var log4js = require('log4js');
var logger = log4js.getLogger('BlockchainAPI');
var express = require('express');
var session = require('express-session');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var http = require('http');
var util = require('util');
var app = express();
var expressJWT = require('express-jwt');
var jwt = require('jsonwebtoken');
var bearerToken = require('express-bearer-token');
var cors = require('cors');
var appEnv = cfenv.getAppEnv();

require('./config.js');
var hfc = require('fabric-client');

var helper = require('./app/helper.js');
var channels = require('./app/create-channel.js');
var join = require('./app/join-channel.js');
var install = require('./app/install-chaincode.js');
var instantiate = require('./app/instantiate-chaincode.js');
var invoke = require('./app/invoke-transaction.js');
var query = require('./app/query.js');
var host = process.env.HOST || hfc.getConfigSetting('host');
var port = process.env.PORT || appEnv.port;
var cloudant = require('./app/cloudant');
var mutipart= require('connect-multiparty');

var mutipartMiddeware = mutipart();
///////////////////////////////////////////////////////////////////////////////
//////////////////////////////// SET CONFIGURATONS ////////////////////////////
///////////////////////////////////////////////////////////////////////////////
app.options('*', cors());
app.use(cors());
//support parsing of application/json type post data
app.use(bodyParser.json());
//support parsing of application/x-www-form-urlencoded post data
app.use(bodyParser.urlencoded({
    extended: false
}));
// set secret variable
app.set('secret', 'thisismysecret');
app.use(expressJWT({
    secret: 'thisismysecret'
}).unless({
    path: ['/users']
}));
app.use(bearerToken());
app.use(function (req, res, next) {
    if (req.originalUrl.indexOf('/users') >= 0) {
        return next();
    }

    var token = req.token;
    jwt.verify(token, app.get('secret'), function (err, decoded) {
        if (err) {
            res.send({
                success: false,
                message: 'Failed to authenticate token. Make sure to include the ' +
                'token returned from /users call in the authorization header ' +
                ' as a Bearer token'
            });
            return;
        } else {
            // add the decoded user name and org name to the request object
            // for the downstream code to use
            req.username = decoded.username;
            req.orgname = decoded.orgName;
            req.company = decoded.company;
            logger.debug(util.format('Decoded from JWT token: username - %s, orgname - %s, company - %s',
                decoded.username, decoded.orgName, decoded.company));
            return next();
        }
    });
});

///////////////////////////////////////////////////////////////////////////////
//////////////////////////////// START SERVER /////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
var server = http.createServer(app).listen(port, function () {
});
logger.info('****************** SERVER STARTED ************************');
logger.info('**************  http://' + host + ':' + port +
    '  ******************');
server.timeout = 240000;

function getNoAccessMessage() {
    var response = {
        success: false,
        message: ' you have no access to call this service, please concat your administrator'
    };
    return response;
}

function getErrorMessage(field) {
    var response = {
        success: false,
        message: field + ' field is missing or Invalid in the request'
    };
    return response;
}

function getLoginErrorMessage() {
    var response = {
        success: false,
        message: ' user id or password is incorrect!'
    };
    return response;
}

function getInvokeErrorMessage(bcerror) {
    // logger.info('bcerror is '+bcerror);
    var response = {
        success: false,
        message: '' + bcerror
    };
    return response;
}

function getInvokeSuccessMessage(txId) {
    var response = {
        success: true,
        message: '',
        transactionId: txId
    };
    return response;
}

function getQuerySuccessMessage(jsonStr) {
    var response = {
        success: true,
        message: '',
        data: jsonStr
    };
    return response;
}

function prepareArgs(args, userRole) {
    var rstArgs = [];
    rstArgs.push(userRole);
    rstArgs.push(args[0]);
    return rstArgs;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////// REST ENDPOINTS START HERE ///////////////////////////
///////////////////////////////////////////////////////////////////////////////
// Register and enroll user
app.post('/users', function (req, res) {
    var username = req.body.username;
    var orgName = req.body.orgName;
    var password = req.body.password;
    logger.debug('End point : /users');
    logger.debug('User name : ' + username);
    logger.debug('Org name  : ' + orgName);
    if (!username) {
        res.json(getErrorMessage('\'username\''));
        return;
    }
    if (!orgName) {
        res.json(getErrorMessage('\'orgName\''));
        return;
    }
    cloudant.login(username, password, function (data) {
        if (data && data.length > 0) {
            logger.info("login success!!!");
            var company = data[0].rows.company;
            var token = jwt.sign({
                exp: Math.floor(Date.now() / 1000) + parseInt(hfc.getConfigSetting('jwt_expiretime')),
                username: username,
                orgName: orgName,
                company: company
            }, app.get('secret'));
            helper.getRegisteredUsers(username, orgName, true).then(function (response) {
                if (response && typeof response !== 'string') {
                    response.token = token;
                    res.json(response);
                } else {
                    res.json({
                        success: false,
                        message: response
                    });
                }
            });
        } else {
            logger.error("login failed");
            res.json(getLoginErrorMessage());
        }
    });

});
// Create Channel
app.post('/channels', function (req, res) {
    logger.info('<<<<<<<<<<<<<<<<< C R E A T E  C H A N N E L >>>>>>>>>>>>>>>>>');
    logger.debug('End point : /channels');
    var channelName = req.body.channelName;
    var channelConfigPath = req.body.channelConfigPath;
    logger.debug('Channel name : ' + channelName);
    logger.debug('channelConfigPath : ' + channelConfigPath); //../artifacts/channel/mychannel.tx
    if (!channelName) {
        res.json(getErrorMessage('\'channelName\''));
        return;
    }
    if (!channelConfigPath) {
        res.json(getErrorMessage('\'channelConfigPath\''));
        return;
    }

    channels.createChannel(channelName, channelConfigPath, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
// Join Channel
app.post('/channels/:channelName/peers', function (req, res) {
    logger.info('<<<<<<<<<<<<<<<<< J O I N  C H A N N E L >>>>>>>>>>>>>>>>>');
    var channelName = req.params.channelName;
    var peers = req.body.peers;
    logger.debug('channelName : ' + channelName);
    logger.debug('peers : ' + peers);
    if (!channelName) {
        res.json(getErrorMessage('\'channelName\''));
        return;
    }
    if (!peers || peers.length == 0) {
        res.json(getErrorMessage('\'peers\''));
        return;
    }

    join.joinChannel(channelName, peers, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
// Install chaincode on target peers
app.post('/chaincodes', function (req, res) {
    logger.debug('==================== INSTALL CHAINCODE ==================');
    var peers = req.body.peers;
    var chaincodeName = req.body.chaincodeName;
    var chaincodePath = req.body.chaincodePath;
    var chaincodeVersion = req.body.chaincodeVersion;
    logger.debug('peers : ' + peers); // target peers list
    logger.debug('chaincodeName : ' + chaincodeName);
    logger.debug('chaincodePath  : ' + chaincodePath);
    logger.debug('chaincodeVersion  : ' + chaincodeVersion);
    if (!peers || peers.length == 0) {
        res.json(getErrorMessage('\'peers\''));
        return;
    }
    if (!chaincodeName) {
        res.json(getErrorMessage('\'chaincodeName\''));
        return;
    }
    if (!chaincodePath) {
        res.json(getErrorMessage('\'chaincodePath\''));
        return;
    }
    if (!chaincodeVersion) {
        res.json(getErrorMessage('\'chaincodeVersion\''));
        return;
    }

    install.installChaincode(peers, chaincodeName, chaincodePath, chaincodeVersion, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
// Instantiate chaincode on target peers
app.post('/channels/:channelName/chaincodes', function (req, res) {
    logger.debug('==================== INSTANTIATE CHAINCODE ==================');
    var chaincodeName = req.body.chaincodeName;
    var chaincodeVersion = req.body.chaincodeVersion;
    var channelName = req.params.channelName;
    var fcn = req.body.fcn;
    var args = req.body.args;
    logger.debug('channelName  : ' + channelName);
    logger.debug('chaincodeName : ' + chaincodeName);
    logger.debug('chaincodeVersion  : ' + chaincodeVersion);
    logger.debug('fcn  : ' + fcn);
    logger.debug('args  : ' + args);
    if (!chaincodeName) {
        res.json(getErrorMessage('\'chaincodeName\''));
        return;
    }
    if (!chaincodeVersion) {
        res.json(getErrorMessage('\'chaincodeVersion\''));
        return;
    }
    if (!channelName) {
        res.json(getErrorMessage('\'channelName\''));
        return;
    }
    if (!args) {
        res.json(getErrorMessage('\'args\''));
        return;
    }
    instantiate.instantiateChaincode(channelName, chaincodeName, chaincodeVersion, fcn, args, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
// Invoke transaction on chaincode on target peers
app.post('/:role/channels/:channelName/chaincodes/:chaincodeName', function (req, res) {
    logger.debug('==================== INVOKE ON CHAINCODE ==================');
    var peers = req.body.peers;
    var chaincodeName = req.params.chaincodeName;
    var channelName = req.params.channelName;
    var role = req.params.role;

    var fcn = req.body.fcn;
    var args = req.body.args;
    var str = JSON.stringify(args);
    var rstArgs = [];
    rstArgs.push(str);
    args = rstArgs;

    logger.debug('channelName  : ' + channelName);
    logger.debug('chaincodeName : ' + chaincodeName);
    logger.debug('fcn  : ' + fcn);
    logger.debug('args  : ' + args);
    if (!chaincodeName) {
        res.json(getErrorMessage('\'chaincodeName\''));
        return;
    }
    if (!channelName) {
        res.json(getErrorMessage('\'channelName\''));
        return;
    }
    if (!fcn) {
        res.json(getErrorMessage('\'fcn\''));
        return;
    }
    if (!args) {
        res.json(getErrorMessage('\'args\''));
        return;
    }
    logger.debug('==================== INSERT DATA TO DATABASE==================');
    var reqData = req.body.args;
    reqData.forEach(item => {
        cloudant.insertSearchDocument(role, item, function (err, body) {
            if (err) {
                logger.error('Error creating document - ', err.message);
                return;
            }
            logger.debug('all records inserted.');
        });
        ;
    });

    invoke.invokeChaincode(peers, channelName, chaincodeName, fcn, args, req.username, req.orgname)
        .then(function (message) {
            res.json(getInvokeSuccessMessage(message));
        }, (err) => {
            logger.debug('error is ' + err);
            res.json(getInvokeErrorMessage(err));
        })
    ;
});
// Query on chaincode on target peers
app.get('/:role/channels/:channelName/chaincodes/:chaincodeName', function (req, res) {
    logger.debug('==================== QUERY BY CHAINCODE ==================');
    var channelName = req.params.channelName;
    var chaincodeName = req.params.chaincodeName;
    let args = req.query.args;
    let fcn = req.query.fcn;
    let peer = req.query.peer;

    logger.debug('channelName : ' + channelName);
    logger.debug('chaincodeName : ' + chaincodeName);
    logger.debug('fcn : ' + fcn);
    logger.debug('args : ' + args);

    if (!chaincodeName) {
        res.json(getErrorMessage('\'chaincodeName\''));
        return;
    }
    if (!channelName) {
        res.json(getErrorMessage('\'channelName\''));
        return;
    }
    if (!fcn) {
        res.json(getErrorMessage('\'fcn\''));
        return;
    }
    if (!args) {
        res.json(getErrorMessage('\'args\''));
        return;
    }
    args = args.replace(/'/g, '"');
    args = JSON.parse(args);
    logger.debug(args);


    query.queryChaincode(peer, channelName, chaincodeName, args, fcn, req.username, req.orgname)
        .then(function (message) {
            res.json(getInvokeSuccessMessage(message));
        });
});
app.post('/:role/channels/:channelName/chaincodes/:chaincodeName/upload', mutipartMiddeware, function (req, res) {
    logger.debug('==================== upload ON CHAINCODE ==================');
    console.log(req.files);

});
app.post('/:role/channels/:channelName/chaincodes/:chaincodeName/query', function (req, res) {
    logger.debug('==================== query ON CHAINCODE ==================');
    var channelName = req.params.channelName;
    var chaincodeName = req.params.chaincodeName;
    var fcn = req.body.fcn;
    var args = req.body.args;
    let peer = req.query.peer;
    var role = req.params.role;
    args = prepareArgs(args, role);

    logger.debug('channelName : ' + channelName);
    logger.debug('chaincodeName : ' + chaincodeName);
    logger.debug('fcn : ' + fcn);
    logger.debug('args : ' + args);
    if (!chaincodeName) {
        res.json(getErrorMessage('\'chaincodeName\''));
        return;
    }
    if (!channelName) {
        res.json(getErrorMessage('\'channelName\''));
        return;
    }
    if (!fcn) {
        res.json(getErrorMessage('\'fcn\''));
        return;
    }
    if (!args) {
        res.json(getErrorMessage('\'args\''));
        return;
    }
    query.queryChaincode(peer, channelName, chaincodeName, args, fcn, req.username, req.orgname)
        .then(function (message) {
            if (message && typeof message === 'string' && message.includes(
                    'Error:')) {
                res.json(getInvokeErrorMessage(message));
            } else {
                res.json(getQuerySuccessMessage(message));
            }

        }, (err) => {
            logger.debug('error is ' + err);
            res.json(getInvokeErrorMessage(err));
        })
    ;
});

app.post('/:role/channels/:channelName/chaincodes/:chaincodeName/:keyprefix/search', function (req, res) {
    logger.debug('==================== query ON CHAINCODE ==================');
    var channelName = req.params.channelName;
    var chaincodeName = req.params.chaincodeName;
    var keyprefix = req.params.keyprefix;
    var fcn = req.body.fcn;
    var args = req.body.args;
    args.keyprefix = keyprefix.toUpperCase();
    let peer = req.query.peer;
    var role = req.params.role;

    logger.debug('channelName : ' + channelName);
    logger.debug('chaincodeName : ' + chaincodeName);
    logger.debug('fcn : ' + fcn);
    logger.debug('args : ' + args);
    if (!chaincodeName) {
        res.json(getErrorMessage('\'chaincodeName\''));
        return;
    }
    if (!channelName) {
        res.json(getErrorMessage('\'channelName\''));
        return;
    }
    if (!fcn) {
        res.json(getErrorMessage('\'fcn\''));
        return;
    }
    if (!args) {
        res.json(getErrorMessage('\'args\''));
        return;
    }
    if (req.company !== role) {
        logger.debug('role:', req.company, role);
        res.json(getNoAccessMessage());
        return;
    }
    cloudant.queryItemNo(args, function (resp) {
        // logger.debug('resp', resp);
        var jsonStr = JSON.stringify(resp);
        // logger.debug(jsonStr);
        var argsArr = [];
        argsArr.push(jsonStr);
        var argsStr = prepareArgs(argsArr, role);
        // logger.debug('argsStr', argsStr);
        query.queryChaincode(peer, channelName, chaincodeName, argsStr, fcn, req.username, req.orgname)
            .then(function (message) {
                if (message && typeof message === 'string' && message.includes(
                        'Error:')) {
                    res.json(getInvokeErrorMessage(message));
                } else {
                    var respObj;
                    // logger.debug('message string', message);
                    if (typeof message !== 'string') {
                        respObj = message;
                    } else {
                        respObj = JSON.parse(message);
                    }

                    var queryData = [];

                    respObj.forEach(soitem => {
                        var keyObj = {
                            KeyPrefix: 'PO',
                            KeysStart: [],
                            KeysEnd: []
                        };
                        if (soitem.PONO && soitem.PONO !== '') {
                            keyObj.KeysStart.push(soitem.PONO);
                            keyObj.KeysStart.push(soitem.POITEM);
                            queryData.push(keyObj);
                        }
                    });
                    var pojsonStr = JSON.stringify(queryData);
                    var poArgsArr = [];
                    poArgsArr.push(pojsonStr);
                    var poArgsStr = prepareArgs(poArgsArr, role);
                    // logger.debug('poArgsStr', poArgsStr);
                    query.queryChaincode(peer, channelName, chaincodeName, poArgsStr, fcn, req.username, req.orgname)
                        .then(function (pomessage) {
                            // logger.debug('pomessage', pomessage);
                            if (pomessage && typeof pomessage === 'string' && pomessage.includes(
                                    'Error:')) {
                                // res.json(getInvokeErrorMessage(pomessage));
                            } else {
                                var respPoObj;
                                if (typeof pomessage !== 'string') {
                                    respPoObj = pomessage;
                                } else {
                                    respPoObj = JSON.parse(pomessage);
                                }
                                // logger.debug('respPoObj', respPoObj);
                                respObj.map(item => {
                                    respPoObj.forEach(poitem => {
                                        // logger.debug('POmessage', item.PONO, item.POITEM, poitem.PONO, poitem.POItemNO);
                                        if (item.PONO === poitem.PONO && item.POITEM === poitem.POItemNO) {
                                            item.GRInfos = poitem.GRInfos;
                                        }
                                    })
                                });

                            }
                            res.json(getQuerySuccessMessage(respObj));
                        }, (err) => {
                            logger.debug('error is ' + err);
                            res.json(getInvokeErrorMessage(err));
                        });
                }

            }, (err) => {
                logger.debug('error is ' + err);
                res.json(getInvokeErrorMessage(err));
            });
    });

});

//  Query Get Block by BlockNumber
app.get('/channels/:channelName/blocks/:blockId', function (req, res) {
    logger.debug('==================== GET BLOCK BY NUMBER ==================');
    let blockId = req.params.blockId;
    let peer = req.query.peer;
    logger.debug('channelName : ' + req.params.channelName);
    logger.debug('BlockID : ' + blockId);
    logger.debug('Peer : ' + peer);
    if (!blockId) {
        res.json(getErrorMessage('\'blockId\''));
        return;
    }

    query.getBlockByNumber(peer, blockId, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
// Query Get Transaction by Transaction ID
app.get('/channels/:channelName/transactions/:trxnId', function (req, res) {
    logger.debug(
        '================ GET TRANSACTION BY TRANSACTION_ID ======================'
    );
    logger.debug('channelName : ' + req.params.channelName);
    let trxnId = req.params.trxnId;
    let peer = req.query.peer;
    if (!trxnId) {
        res.json(getErrorMessage('\'trxnId\''));
        return;
    }

    query.getTransactionByID(peer, trxnId, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
// Query Get Block by Hash
app.get('/channels/:channelName/blocks', function (req, res) {
    logger.debug('================ GET BLOCK BY HASH ======================');
    logger.debug('channelName : ' + req.params.channelName);
    let hash = req.query.hash;
    let peer = req.query.peer;
    if (!hash) {
        res.json(getErrorMessage('\'hash\''));
        return;
    }

    query.getBlockByHash(peer, hash, req.username, req.orgname).then(
        function (message) {
            res.send(message);
        });
});
//Query for Channel Information
app.get('/channels/:channelName', function (req, res) {
    logger.debug(
        '================ GET CHANNEL INFORMATION ======================');
    logger.debug('channelName : ' + req.params.channelName);
    let peer = req.query.peer;

    query.getChainInfo(peer, req.username, req.orgname).then(
        function (message) {
            res.send(message);
        });
});
// Query to fetch all Installed/instantiated chaincodes
app.get('/chaincodes', function (req, res) {
    var peer = req.query.peer;
    var installType = req.query.type;
    //TODO: add Constnats
    if (installType === 'installed') {
        logger.debug(
            '================ GET INSTALLED CHAINCODES ======================');
    } else {
        logger.debug(
            '================ GET INSTANTIATED CHAINCODES ======================');
    }

    query.getInstalledChaincodes(peer, installType, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
// Query to fetch channels
app.get('/channels', function (req, res) {
    logger.debug('================ GET CHANNELS ======================');
    logger.debug('peer: ' + req.query.peer);
    var peer = req.query.peer;
    if (!peer) {
        res.json(getErrorMessage('\'peer\''));
        return;
    }

    query.getChannels(peer, req.username, req.orgname)
        .then(function (message) {
            res.send(message);
        });
});
