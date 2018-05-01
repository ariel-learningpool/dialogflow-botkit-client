/**
 * Copyright 2017 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const Botkit = require('botkit');
const apiai = require('apiai');

const uuidV4 = require('uuid/v4');
const Entities = require('html-entities').XmlEntities;
const decoder = new Entities();
const redis = require('redis');
let redisClient = '';

module.exports = function (apiaiToken, redisPort = '6379', redisHost = '127.0.0.1') {

    if (!redisClient) {
        redisClient = redis.createClient(redisPort, redisHost);
    }

    return createApiAiProcessing(apiaiToken);
};

function isDefined(obj) {
    if (typeof obj == 'undefined') {
        return false;
    }

    if (!obj) {
        return false;
    }

    return obj != null;
}

function createApiAiProcessing(token) {
    let worker = {};

    worker.apiaiService = apiai(token);
    worker.sessionIds = {};

    worker.actionCallbacks = {};
    worker.allCallback = [];

    worker.action = function (action, callback) {
        if (worker.actionCallbacks[action]) {
            worker.actionCallbacks[action].push(callback);
        } else {
            worker.actionCallbacks[action] = [callback];
        }

        return worker;
    };

    worker.all = function (callback) {
        worker.allCallback.push(callback);
        return worker;
    };


    worker.process = function (message, bot) {
        redisClient.hgetall("sessionIds", function(err, sessions) {
            worker.sessionIds = sessions || {};

            try {

                if (isDefined(message.text)) {
                    let userId = message.user;

                    let requestText = decoder.decode(message.text);
                    requestText = requestText.replace("’", "'");

                    if (isDefined(bot.identity) && isDefined(bot.identity.id)) {
                        // it seems it is Slack

                        if (message.user == bot.identity.id) {
                            // message from bot can be skipped
                            return;
                        }

                        if (message.text.indexOf("<@U") == 0 && message.text.indexOf(bot.identity.id) == -1) {
                            // skip other users direct mentions
                            return;
                        }

                        let botId = '<@' + bot.identity.id + '>';
                        if (requestText.indexOf(botId) > -1) {
                            requestText = requestText.replace(botId, '');
                        }

                        userId = message.channel;
                    }


                    if (!(userId in worker.sessionIds)) {
                        const sessionId = uuidV4();
                        redisClient.hset("sessionIds", userId, sessionId);
                        worker.sessionIds[userId] = sessionId;
                    }

                    let request = worker.apiaiService.textRequest(requestText,
                        {
                            sessionId: worker.sessionIds[userId],
                            originalRequest: {
                                data: message,
                                source: "api-ai-botkit"
                            }
                        });

                    request.on('response', (response) => {

                        worker.allCallback.forEach((callback) => {
                            callback(message, response, bot);
                        });

                        if (isDefined(response.result)) {
                            let action = response.result.action;

                            if (isDefined(action)) {
                                if (worker.actionCallbacks[action]) {
                                    worker.actionCallbacks[action].forEach((callback) => {
                                        callback(message, response, bot);
                                    });
                                }
                            }
                        }
                    });

                    request.on('error', (error) => {
                        console.error(error);
                    });

                    request.end();
                }

            } catch (err) {
                console.error(err);
            }
        });
    };

    return worker;
}