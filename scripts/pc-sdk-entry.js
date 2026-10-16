// Deliberately only the documented desktop in-client auth API, not bots or legacy OAuth.
import dd from 'dingtalk-jsapi/core';
import 'dingtalk-jsapi/platform/pc';
// The upstream file is CommonJS: use its documented callable export, not its namespace default.
import {requestAuthCode$ as requestAuthCode} from 'dingtalk-jsapi/api/union/requestAuthCode';
window.dd={env:dd.env,requestAuthCode};
