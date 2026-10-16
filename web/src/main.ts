import { createApp } from 'vue'
import App from './App.vue'
import { createAppRouter } from './router'
import './ui/tokens.css'
import './ui/base.css'

createApp(App).use(createAppRouter()).mount('#app')
