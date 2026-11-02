// 前端入口：挂载 React 应用到 #root
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// 创建根节点并渲染（StrictMode 开启开发期严格检查）
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
