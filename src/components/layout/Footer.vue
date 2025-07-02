<template>
  <footer class="footer">
    <div class="container">
      <div class="footer-content">
        <!-- 版本和版权信息 -->
        <div class="footer-info">
          <div class="version-info">
            <span class="version-badge">Beta 0.0.1</span>
          </div>
          <div class="copyright">
            <p>&copy; 2025 timeStarry. Built with ❤️ using Cursor.</p>
          </div>
        </div>

        <!-- 友情链接 -->
        <div class="footer-links">
          <h4>友情链接</h4>
          <div class="links-grid">
            <a href="https://blog.tsio.top/" target="_blank" rel="noopener noreferrer" class="link-item">
              <span class="link-icon">📝</span>
              <div class="link-content">
                <span class="link-title">个人博客</span>
                <span class="link-desc">博学笃志，切问近思</span>
              </div>
            </a>
            
            <a href="https://github.com/timeStarry/frameMark" target="_blank" rel="noopener noreferrer" class="link-item">
              <span class="link-icon">⭐</span>
              <div class="link-content">
                <span class="link-title">项目仓库</span>
                <span class="link-desc">github/timeStarry/frameMark</span>
              </div>
            </a>
            
            <a href="https://watermark.yiyin.org.cn/" target="_blank" rel="noopener noreferrer" class="link-item">
              <span class="link-icon">🖼️</span>
              <div class="link-content">
                <span class="link-title">壹印</span>
                <span class="link-desc">专业水印工具</span>
              </div>
            </a>
            
            <a href="https://cv.shuwo.net/" target="_blank" rel="noopener noreferrer" class="link-item">
              <span class="link-icon">📷</span>
              <div class="link-content">
                <span class="link-title">Camera version</span>
                <span class="link-desc">在线照片边框水印</span>
              </div>
            </a>
          </div>
        </div>
      </div>
    </div>
  </footer>
</template>

<script setup>
// 无需额外逻辑
</script>

<style scoped>
.footer {
  background: rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(20px);
  border-top: 1px solid rgba(161, 136, 117, 0.4);
  box-shadow: 0 -1px 0 rgba(161, 136, 117, 0.2), 0 -2px 8px rgba(0, 0, 0, 0.1);
  padding: 40px 0 30px;
  margin-top: auto;
}

.footer-content {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 40px;
  align-items: start;
}

.footer-info {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.version-info {
  .version-badge {
    display: inline-block;
    background: rgba(161, 136, 117, 0.3);
    color: white;
    padding: 6px 12px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.5px;
    border: 1px solid rgba(161, 136, 117, 0.5);
  }
}

.copyright {
  p {
    color: rgba(255, 255, 255, 0.8);
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
  }
}

.footer-links {
  h4 {
    color: white;
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 20px 0;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  }
}

.links-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.link-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  text-decoration: none;
  transition: all 0.3s ease;
  
  &:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
    transform: translateY(-2px);
  }
}

.link-icon {
  font-size: 20px;
  opacity: 0.9;
}

.link-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.link-title {
  color: white;
  font-size: 14px;
  font-weight: 500;
}

.link-desc {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
}

@media (max-width: 768px) {
  .footer {
    padding: 30px 0 20px;
  }
  
  .footer-content {
    grid-template-columns: 1fr;
    gap: 30px;
  }
  
  .links-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }
  
  .link-item {
    padding: 10px 12px;
  }
  
  .link-icon {
    font-size: 18px;
  }
  
  .link-title {
    font-size: 13px;
  }
  
  .link-desc {
    font-size: 11px;
  }
}

@media (max-width: 480px) {
  .footer-content {
    gap: 20px;
  }
  
  .footer-info {
    gap: 15px;
  }
  
  .version-info .version-badge {
    font-size: 11px;
    padding: 5px 10px;
  }
  
  .copyright p {
    font-size: 12px;
  }
  
  .footer-links h4 {
    font-size: 14px;
    margin-bottom: 15px;
  }
}
</style> 