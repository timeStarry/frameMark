import { createApp } from './app.mjs';
const { app } = createApp({directory:process.env.DATA_DIR||'./data'});
app.listen(Number(process.env.PORT||18140),process.env.HOST||'127.0.0.1',()=>console.log('Markr listening; identity disabled'));
