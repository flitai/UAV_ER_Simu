import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './app.css'
// 在第一次渲染前定下主题（D-078），免得先闪一帧浅色
import './shell/theme.js'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
