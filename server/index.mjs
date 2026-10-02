import { createSmtpMailer } from './mail.mjs';
import { createApp } from './app.mjs';
const { app } = createApp({directory:process.env.DATA_DIR||'./data', identity:{enabled:process.env.IDENTITY_ENABLED==='true',registrationOpen:process.env.REGISTRATION_OPEN==='true',origin:process.env.IDENTITY_ORIGIN,privateTrial:process.env.IDENTITY_TRIAL_MODE==='tailscale-http',bindHost:process.env.HOST,mailer:process.env.IDENTITY_ENABLED==='true'?createSmtpMailer():null}});
app.listen(Number(process.env.PORT||18140),process.env.HOST||'127.0.0.1',()=>console.log('Markr listening; identity '+(process.env.IDENTITY_ENABLED==='true'?'enabled':'disabled')));
