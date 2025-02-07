import * as qs from 'qs';
import * as crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import config from './config';


interface TuyaResponse<T> {
 success: boolean;
 code: number;
 msg: string;
 result: T;
}

interface TokenResult {
 access_token: string;
 expire_time: number;
 refresh_token: string;
 uid: string;
}

interface DeviceStatus {
 code: string;
 value: any;
 t: number;
}

interface RequestHeaders {
 [key: string]: string;
}

let token: string = '';
const voltageLog: number[] = new Array(48).fill(0);


const bot = new TelegramBot(config.telegramToken);
const httpClient: AxiosInstance = axios.create({ baseURL: config.host, timeout: 5000 });

const encryptStr = async (str: string, secret: string): Promise<string> => 
 crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex').toUpperCase();

const getRequestSign = async (
 path: string,
 method: string,
 headers: RequestHeaders = {},
 query: { [key: string]: any } = {},
 body: { [key: string]: any } = {},
): Promise<RequestHeaders> => {
 const t = Date.now().toString();
 const [uri, pathQuery] = path.split('?');
 const queryMerged = { ...query, ...qs.parse(pathQuery) };
 const sortedQuery = Object.keys(queryMerged).sort().reduce((acc, key) => ({ ...acc, [key]: query[key] }), {});
 const querystring = decodeURIComponent(qs.stringify(sortedQuery));
 const url = querystring ? `${uri}?${querystring}` : uri;
 const contentHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
 const stringToSign = [method, contentHash, '', url].join('\n');
 const signStr = config.accessKey + token + t + stringToSign;
 return {
   t,
   path: url,
   client_id: config.accessKey,
   sign: await encryptStr(signStr, config.secretKey),
   sign_method: 'HMAC-SHA256',
   access_token: token,
 };
};

const getToken = async (): Promise<void> => {
 const method = 'GET';
 const timestamp = Date.now().toString();
 const signUrl = '/v1.0/token?grant_type=1';
 const contentHash = crypto.createHash('sha256').update('').digest('hex');
 const stringToSign = [method, contentHash, '', signUrl].join('\n');
 const signStr = config.accessKey + timestamp + stringToSign;
 const headers = { t: timestamp, sign_method: 'HMAC-SHA256', client_id: config.accessKey, sign: await encryptStr(signStr, config.secretKey) };
 const { data } = await httpClient.get<TuyaResponse<TokenResult>>('/v1.0/token?grant_type=1', { headers });
 if (!data?.success) throw new Error(`fetch failed: ${data.msg}`);
 token = data.result.access_token;
};

const getDeviceInfo = async (): Promise<void> => {
 const method = 'GET';
 const url = `/v1.0/devices/${config.deviceId}/status`;
 const reqHeaders = await getRequestSign(url, method, {}, {});
 const { data } = await httpClient.request<TuyaResponse<DeviceStatus[]>>({ method, data: {}, params: {}, headers: reqHeaders, url: reqHeaders.path });
 if (!data?.success) throw new Error(`request api failed: ${data.msg}`);

 const voltageStatus = data.result.find(status => status.code === 'cur_voltage');
 if (voltageStatus) {
   const voltage = voltageStatus.value / 10;
   const index = Math.floor((Date.now() / 1000 / 60 / 30) % 48);
   voltageLog[index] = voltage;

   let message = '';
   if (voltage > 215) message = `🟢 Напруга в нормі: ${voltage.toFixed(1)}V`;
   else if (voltage < 208) message = `🔴 Дуже низька напруга: ${voltage.toFixed(1)}V`;
   else if (voltage < 215) message = `🟡 Низька напруга: ${voltage.toFixed(1)}V`;
   
   if (message) await bot.sendMessage(config.chatId, message);
 }
};

const sendDailyStats = async (): Promise<void> => {
 const below198 = voltageLog.filter(v => v < 198).length * 30;
 const below208 = voltageLog.filter(v => v < 208).length * 30;
 const above215 = voltageLog.filter(v => v > 215).length * 30;
 const statsMessage = `📊 Статистика за 24 години:
⚠️ Напруга <198V: ${below198} хв
⚠️ Напруга <208V: ${below208} хв
✅ Напруга >215V: ${above215} хв`;
 await bot.sendMessage(config.chatId, statsMessage);
 voltageLog.fill(0);
};

const monitorVoltage = async (): Promise<void> => {
 try {
   await getToken();
   await getDeviceInfo();
   setInterval(getDeviceInfo, 30000);
   const now = new Date();
   const millisTill10AM = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0).getTime() - now.getTime();
   setTimeout(() => {
     sendDailyStats();
     setInterval(sendDailyStats, 24 * 60 * 60 * 1000);
   }, millisTill10AM);
 } catch (error) {
   console.error(`Error: ${error}`);
 }
};

monitorVoltage();
