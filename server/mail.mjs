import nodemailer from 'nodemailer';
import {parse} from 'dotenv';
import {openSync,readFileSync,fstatSync,closeSync,constants} from 'node:fs';
import validator from 'validator';
export function smtpSettings(env=process.env) {
  if(!env.SMTP_CONFIG_FILE)return env;
  let fd;
  try {
    fd=openSync(env.SMTP_CONFIG_FILE,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw Error('unsafe config');
    const source=parse(readFileSync(fd));
    const prefix=env.SMTP_CONFIG_PREFIX||'';
    if(!['','THREADMARK_'].includes(prefix))throw Error('unsupported prefix');
    const settings=prefix==='THREADMARK_'?{SMTP_HOST:source.THREADMARK_SMTP_HOST,SMTP_PORT:source.THREADMARK_SMTP_PORT,SMTP_USER:source.THREADMARK_SMTP_USERNAME,SMTP_PASSWORD:source.THREADMARK_SMTP_PASSWORD,SMTP_FROM:source.THREADMARK_SMTP_FROM_EMAIL}:{SMTP_HOST:source.SMTP_HOST,SMTP_PORT:source.SMTP_PORT,SMTP_USER:source.SMTP_USER,SMTP_PASSWORD:source.SMTP_PASSWORD,SMTP_FROM:source.SMTP_FROM};
    if(prefix==='THREADMARK_' && !((Number(settings.SMTP_PORT)===465&&source.THREADMARK_SMTP_USE_SSL==='true')||(Number(settings.SMTP_PORT)===587&&source.THREADMARK_SMTP_STARTTLS==='true')))throw Error('TLS mode mismatch');
    return settings;
  }catch{throw Error('SMTP configuration file unavailable or unsafe');}
  finally{if(fd!==undefined)closeSync(fd);}
}
// No network connection occurs at construction; secrets are supplied by server-local environment only.
export function createSmtpMailer(env = process.env) {
  env=smtpSettings(env);
  if(!env.SMTP_HOST||!env.SMTP_FROM||!env.SMTP_USER||!env.SMTP_PASSWORD) return null;
  const port=Number(env.SMTP_PORT||465);
  if(![465,587].includes(port))throw Error('SMTP_PORT must be 465 or 587');
  if(! /^[a-zA-Z0-9.-]+$/.test(env.SMTP_HOST)||!validator.isEmail(env.SMTP_FROM,{allow_display_name:false}))throw Error('Invalid SMTP host or sender');
  const transport=nodemailer.createTransport({host:env.SMTP_HOST,port,secure:port===465,requireTLS:true,auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false});
  return {
    connectionInfo:{host:env.SMTP_HOST,port,tls:port===465?'TLS':'STARTTLS',from:env.SMTP_FROM},
    async sendVerification({to,url,trial=false}) {await transport.sendMail({from:env.SMTP_FROM,to,subject:trial?'[Markr 私网测试] 验证邮箱':'验证你的 Markr 邮箱',text:`${trial?'这是一封 Markr 私网注册试验邮件。请仅使用一次性试验密码，不要使用常用或正式密码。\n\n':''}打开以下链接并设置密码，即可完成 Markr 注册。链接 30 分钟内有效，只能使用一次。\n\n${url}\n\n如果你没有申请注册，请忽略此邮件。`});},
    verifyConnection:()=>transport.verify(),close:()=>transport.close()
  };
}
