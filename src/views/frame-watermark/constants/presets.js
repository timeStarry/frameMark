// 预设样式配置
export const presets = [
  {
    id: 'blur-classic',
    name: '经典毛玻璃',
    description: '强烈毛玻璃，优雅签名',
    icon: '🌫️',
    config: {
      frame: {
        type: 'blur',
        widthPercent: 10,
        borderRadiusPercent: 3,
        blurIntensity: 42
      },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 3,
        color: '#ffffff',
        opacity: 1,
        position: 'bottom-center'
      },
      exif: {
        fontFamily: 'Inter',
        fontSizePercent: 2.2,
        position: 'bottom-center',
        fields: ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']
      }
    }
  },
  {
    id: 'solid-clean',
    name: '简约纯色',
    description: '清晰边框，经典布局',
    icon: '⬜',
    config: {
      frame: {
        type: 'solid',
        widthPercent: 15,
        borderRadiusPercent: 0,
        color: '#ffffff'
      },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 3,
        color: '#000000',
        opacity: 1,
        position: 'bottom-center'
      },
      exif: {
        fontFamily: 'Comfortaa',
        fontSizePercent: 2.2,
        position: 'bottom-center',
        fields: ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']
      }
    }
  },
  {
    id: 'gradient-warm',
    name: '暖调渐变',
    description: '奶茶色调，温暖质感',
    icon: '🎨',
    config: {
      frame: {
        type: 'gradient',
        widthPercent: 15,
        borderRadiusPercent: 0,
        gradientColor1: '#D4C0A1',
        gradientColor2: '#D6C5B9'
      },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 5,
        color: '#ffffff',
        opacity: 1,
        position: 'top-center'
      },
      exif: {
        fontFamily: 'Cormorant Garamond',
        fontSizePercent: 3.4,
        position: 'bottom-center',
        fields: ['FNumber', 'ExposureTime', 'FocalLength', 'ISO']
      }
    }
  },
  {
    id: 'bottom-bar-minimal',
    name: '底部条幅',
    description: '简洁条幅，时间标记',
    icon: '📏',
    config: {
      frame: {
        type: 'bottom-bar',
        widthPercent: 0
      },
      watermark: {
        text: 'Photographer',
        fontFamily: 'Dancing Script',
        fontSizePercent: 3,
        color: '#333333',
        opacity: 1,
        bottomBarPosition: 'left'
      },
      exif: {
        fontFamily: 'Inter',
        fontSizePercent: 2.2,
        bottomBarPosition: 'right',
        fields: ['DateTime', 'Time']
      }
    }
  }
] 
