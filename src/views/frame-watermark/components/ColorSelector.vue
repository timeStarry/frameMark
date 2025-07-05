<template>
  <div class="color-selector">
    <!-- 莫兰蒂色系推荐 -->
    <div v-if="type === 'solid'" class="color-palette">
      <div class="palette-title">莫兰蒂色系推荐</div>
      <div class="color-grid">
        <div 
          v-for="colorItem in morandiColors" 
          :key="colorItem.name"
          class="color-option" 
          :class="{ active: selectedColor === colorItem.color }"
          :style="{ backgroundColor: colorItem.color }"
          @click="selectColor(colorItem.color)"
          :title="colorItem.name"
        >
          <span class="color-name">{{ colorItem.name }}</span>
        </div>
      </div>
    </div>
    
    <!-- 渐变色组合推荐 -->
    <div v-if="type === 'gradient'" class="gradient-palette">
      <div class="palette-title">优雅渐变推荐</div>
      <div class="gradient-grid">
        <div 
          v-for="gradientItem in gradientCombos" 
          :key="gradientItem.name"
          class="gradient-option"
          :class="{ 
            active: selectedGradientColor1 === gradientItem.colors[0] && 
                    selectedGradientColor2 === gradientItem.colors[1] 
          }"
          :style="{ 
            background: `linear-gradient(135deg, ${gradientItem.colors[0]}, ${gradientItem.colors[1]})` 
          }"
          @click="selectGradientCombo(gradientItem.colors)"
          :title="gradientItem.name"
        >
          <span class="gradient-name">{{ gradientItem.name }}</span>
        </div>
      </div>
    </div>
    
    <!-- 更多颜色/自定义颜色选项 -->
    <div class="more-colors">
      <button @click="toggleMoreColors" class="more-colors-btn">
        {{ showMoreColors ? '收起' : (type === 'gradient' ? '自定义渐变' : '更多颜色') }}
        <span class="toggle-arrow" :class="{ expanded: showMoreColors }">▼</span>
      </button>
      
      <!-- 单色自定义 -->
      <div v-if="showMoreColors && type === 'solid'" class="custom-color-input">
        <input 
          type="color" 
          :value="selectedColor" 
          @input="updateColor"
          class="color-picker"
        >
        <span class="color-value">{{ selectedColor }}</span>
      </div>
      
      <!-- 渐变自定义 -->
      <div v-if="showMoreColors && type === 'gradient'" class="gradient-custom">
        <div class="gradient-color-row">
          <label>起始色</label>
          <input 
            type="color" 
            :value="selectedGradientColor1" 
            @input="updateGradientColor1"
            class="color-picker"
          >
          <span class="color-value">{{ selectedGradientColor1 }}</span>
        </div>
        <div class="gradient-color-row">
          <label>结束色</label>
          <input 
            type="color" 
            :value="selectedGradientColor2" 
            @input="updateGradientColor2"
            class="color-picker"
          >
          <span class="color-value">{{ selectedGradientColor2 }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  type: {
    type: String,
    required: true,
    validator: (value) => ['solid', 'gradient'].includes(value)
  },
  selectedColor: {
    type: String,
    default: '#ffffff'
  },
  selectedGradientColor1: {
    type: String,
    default: '#FFB347'
  },
  selectedGradientColor2: {
    type: String,
    default: '#FF8C94'
  },
  showMoreColors: {
    type: Boolean,
    default: false
  },
  morandiColors: {
    type: Array,
    required: true
  },
  gradientCombos: {
    type: Array,
    required: true
  }
})

const emit = defineEmits([
  'select-color',
  'select-gradient-combo',
  'toggle-more-colors',
  'update-color',
  'update-gradient-color1',
  'update-gradient-color2'
])

const selectColor = (color) => {
  emit('select-color', color)
}

const selectGradientCombo = (colors) => {
  emit('select-gradient-combo', colors)
}

const toggleMoreColors = () => {
  emit('toggle-more-colors')
}

const updateColor = (event) => {
  emit('update-color', event.target.value)
}

const updateGradientColor1 = (event) => {
  emit('update-gradient-color1', event.target.value)
}

const updateGradientColor2 = (event) => {
  emit('update-gradient-color2', event.target.value)
}
</script>

<style scoped>
.color-palette, .gradient-palette {
  margin-top: 12px;
  
  .palette-title {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 8px;
    font-weight: 500;
  }
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.color-option {
  position: relative;
  height: 36px;
  border-radius: 8px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.3);
  }
  
  &.active {
    border-color: #a18875;
    box-shadow: 0 0 0 1px #a18875, 0 4px 12px rgba(161, 136, 117, 0.4);
    transform: translateY(-1px);
  }
  
  .color-name {
    font-size: 10px;
    color: rgba(0, 0, 0, 0.8);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
    text-align: center;
    padding: 2px 4px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.9);
    backdrop-filter: blur(4px);
  }
}

.gradient-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.gradient-option {
  position: relative;
  height: 40px;
  border-radius: 8px;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    border-color: rgba(255, 255, 255, 0.3);
  }
  
  &.active {
    border-color: #a18875;
    box-shadow: 0 0 0 1px #a18875, 0 4px 12px rgba(161, 136, 117, 0.4);
    transform: translateY(-1px);
  }
  
  .gradient-name {
    font-size: 11px;
    color: rgba(0, 0, 0, 0.8);
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
    text-align: center;
    padding: 3px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(4px);
  }
}

.more-colors {
  margin-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  padding-top: 12px;
}

.more-colors-btn {
  width: 100%;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  padding: 8px 12px;
  color: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: space-between;
  
  &:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
  }
  
  .toggle-arrow {
    transition: transform 0.3s ease;
    font-size: 10px;
    
    &.expanded {
      transform: rotate(180deg);
    }
  }
}

.custom-color-input {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  
  .color-picker {
    width: 40px;
    height: 30px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    background: none;
    
    &::-webkit-color-swatch {
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 4px;
    }
  }
  
  .color-value {
    font-family: monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    background: rgba(0, 0, 0, 0.3);
    padding: 4px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
}

.gradient-custom {
  margin-top: 8px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.gradient-color-row {
  display: flex;
  align-items: center;
  gap: 8px;
  
  label {
    min-width: 50px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.8);
    margin: 0;
  }
  
  .color-picker {
    width: 40px;
    height: 28px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
    background: none;
    
    &::-webkit-color-swatch {
      border: 1px solid rgba(255, 255, 255, 0.3);
      border-radius: 4px;
    }
  }
  
  .color-value {
    flex: 1;
    font-family: monospace;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    background: rgba(0, 0, 0, 0.3);
    padding: 4px 6px;
    border-radius: 3px;
    text-transform: uppercase;
  }
}
</style> 