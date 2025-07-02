<template>
  <div class="home">
    <div class="container">
      <!-- 主标题区域 -->
      <div class="hero-section">
        <h1 class="main-title">Markr</h1>
        <p class="subtitle">专业的图片处理工具箱</p>
        <p class="description">简洁优雅，快速便捷，本地处理</p>
      </div>

      <!-- 功能入口 -->
      <div class="features-grid">
        <router-link to="/frame-watermark" class="feature-card">
          <div class="feature-icon">🖼️</div>
          <h3>边框水印</h3>
          <p>为照片添加精美边框和个性水印，支持多种边框样式和EXIF信息显示</p>
        </router-link>

        <router-link to="/image-collage" class="feature-card">
          <div class="feature-icon">🎨</div>
          <h3>图片拼图</h3>
          <p>多张图片智能拼接，支持多种布局方式，打造完美的照片组合</p>
        </router-link>
      </div>

      <!-- 技术特点 -->
      <div class="highlights">
        <h2 class="section-title">技术特征</h2>
        <div class="highlights-grid">
          <div class="highlight-item">
            <div class="highlight-icon">🔒</div>
            <h4>隐私安全</h4>
            <p>纯前端处理，图片不上传服务器，绝对保护您的隐私</p>
          </div>
          
          <div class="highlight-item">
            <div class="highlight-icon">📱</div>
            <h4>响应式设计</h4>
            <p>完美适配各种设备屏幕，手机电脑都能流畅使用</p>
          </div>
          
          <div class="highlight-item">
            <div class="highlight-icon">⚡</div>
            <h4>便捷使用</h4>
            <p>无需注册登录，打开即用，简单直观的操作界面</p>
          </div>
          
          <div class="highlight-item">
            <div class="highlight-icon">🎛️</div>
            <h4>个性配置</h4>
            <p>丰富的自定义选项，满足不同场景的个性化需求</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 无需额外逻辑
</script>

<style scoped>
.home {
  padding: 80px 0;
}

.hero-section {
  text-align: center;
  margin-bottom: 80px;
}

.main-title {
  font-size: 4rem;
  font-weight: 700;
  color: white;
  margin-bottom: 20px;
  letter-spacing: -2px;
}

.subtitle {
  font-size: 1.5rem;
  color: rgba(255, 255, 255, 0.9);
  margin-bottom: 12px;
  font-weight: 500;
}

.description {
  font-size: 1.1rem;
  color: rgba(255, 255, 255, 0.7);
  max-width: 600px;
  margin: 0 auto;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 32px;
  margin-bottom: 100px;
}

.feature-card {
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 16px;
  padding: 40px 32px;
  text-align: center;
  text-decoration: none;
  color: inherit;
  transition: all 0.4s ease;
  position: relative;
  overflow: hidden;
  
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
    transition: left 0.6s ease;
  }
  
  &:hover {
    transform: translateY(-8px);
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.4);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    
    &::before {
      left: 100%;
    }
  }
}

.feature-icon {
  font-size: 3rem;
  margin-bottom: 24px;
  display: block;
}

.feature-card h3 {
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 16px;
  color: white;
}

.feature-card p {
  color: rgba(255, 255, 255, 0.85);
  line-height: 1.6;
  font-size: 0.95rem;
}

.highlights {
  text-align: center;
}

.section-title {
  font-size: 2.5rem;
  font-weight: 700;
  color: white;
  margin-bottom: 60px;
}

.highlights-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 40px;
}

.highlight-item {
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  padding: 32px 24px;
  text-align: center;
  transition: all 0.3s ease;
  
  &:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.25);
    transform: translateY(-4px);
  }
}

.highlight-icon {
  font-size: 2.5rem;
  margin-bottom: 20px;
  display: block;
}

.highlight-item h4 {
  font-size: 1.25rem;
  font-weight: 600;
  color: white;
  margin-bottom: 12px;
}

.highlight-item p {
  color: rgba(255, 255, 255, 0.8);
  line-height: 1.6;
  font-size: 0.9rem;
}

@media (max-width: 768px) {
  .home {
    padding: 60px 0;
  }
  
  .hero-section {
    margin-bottom: 60px;
  }
  
  .main-title {
    font-size: 3rem;
  }
  
  .subtitle {
    font-size: 1.3rem;
  }
  
  .features-grid {
    grid-template-columns: 1fr;
    gap: 24px;
    margin-bottom: 80px;
  }
  
  .feature-card {
    padding: 32px 24px;
  }
  
  .section-title {
    font-size: 2rem;
    margin-bottom: 40px;
  }
  
  .highlights-grid {
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 24px;
  }
  
  .highlight-item {
    padding: 24px 20px;
  }
}
</style> 