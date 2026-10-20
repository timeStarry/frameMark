import { createApp } from 'vue'
import App from './App.vue'
import { createAppRouter } from './router'
import { refresh } from './api/session'
import './ui/tokens.css'
import './ui/base.css'

// Load the session in the background; the /me guard awaits it if needed.
void refresh()

createApp(App).use(createAppRouter()).mount('#app')
