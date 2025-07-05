<template>
  <header class="header">
    <div class="container">
      <div class="header-content">
        <div class="logo">
          <router-link to="/" class="logo-link">
            <div class="logo-icon">📷</div>
            <span class="logo-text">Markr</span>
          </router-link>
        </div>
        
        <nav class="nav">
          <router-link 
            to="/" 
            class="nav-link" 
            :class="{ active: $route.name === 'Home' }"
          >
            首页
          </router-link>
          <router-link 
            to="/frame-watermark" 
            class="nav-link"
            :class="{ active: $route.name === 'FrameWatermark' }"
          >
            边框水印
          </router-link>
          <router-link 
            to="/image-collage" 
            class="nav-link"
            :class="{ active: $route.name === 'ImageCollage' }"
          >
            图片拼图
          </router-link>
          
        </nav>
      </div>
    </div>
  </header>
</template>


<style scoped>
.header {
  background: rgba(161, 136, 117, 0.25);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid rgba(161, 136, 117, 0.4);
  box-shadow: 0 1px 0 rgba(161, 136, 117, 0.2), 0 2px 8px rgba(0, 0, 0, 0.1);
  position: sticky;
  top: 0;
  z-index: 1000;
  height: 80px;
}

.header-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 80px;
}

.logo-link {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  color: white;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.logo-icon {
  font-size: 32px;
}

.logo-text {
  font-size: 28px;
  font-weight: 700;
  color: white;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.nav {
  display: flex;
  gap: 32px;
  align-items: center;
}

.nav-link {
  text-decoration: none;
  color: rgba(255, 255, 255, 0.9);
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 8px;
  transition: all 0.3s ease;
  position: relative;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  
  &:hover {
    color: white;
    background: rgba(255, 255, 255, 0.1);
  }
  
  &.active {
    color: white;
    background: rgba(255, 255, 255, 0.15);
    
    &::after {
      content: '';
      position: absolute;
      bottom: -2px;
      left: 50%;
      transform: translateX(-50%);
      width: 20px;
      height: 3px;
      background: linear-gradient(135deg, #a18875 0%, #8b7968 100%);
      border-radius: 2px;
    }
  }
}

.favorite-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.3);
  color: rgba(255, 255, 255, 0.9);
  font-weight: 500;
  padding: 8px 16px;
  border-radius: 8px;
  transition: all 0.3s ease;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  font-size: 14px;
  
  &:hover {
    color: white;
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.5);
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    
    .favorite-icon {
      transform: scale(1.1);
    }
  }
  
  &:active {
    transform: translateY(0);
  }
}

.favorite-icon {
  font-size: 16px;
  transition: transform 0.3s ease;
}

.favorite-text {
  font-size: 14px;
}

@media (max-width: 768px) {
  .header-content {
    flex-direction: column;
    gap: 16px;
    height: auto;
    padding: 16px 0;
  }
  
  .header {
    height: auto;
  }
  
  .nav {
    gap: 16px;
    flex-wrap: wrap;
    justify-content: center;
  }
  
  .logo-text {
    font-size: 24px;
  }
  
  .logo-icon {
    font-size: 28px;
  }
  
  .favorite-btn {
    padding: 6px 12px;
    font-size: 13px;
    
    .favorite-text {
      font-size: 13px;
    }
    
    .favorite-icon {
      font-size: 14px;
    }
  }
}

@media (max-width: 480px) {
  .nav {
    gap: 12px;
  }
  
  .favorite-btn {
    .favorite-text {
      display: none;
    }
    
    padding: 8px;
    min-width: 36px;
    justify-content: center;
  }
}
</style> 