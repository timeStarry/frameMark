<template>
  <div class="font-selector" :class="{ disabled: !fontsLoaded }">
    <div 
      class="font-selector-current" 
      :class="{ open: isOpen }" 
      @click="toggleDropdown"
      :disabled="!fontsLoaded"
    >
      <span class="font-display" :style="{ fontFamily: displayFont }">
        {{ displayName }}
      </span>
      <span class="dropdown-arrow">▼</span>
    </div>
    
    <div v-if="isOpen" class="font-dropdown">
      <template v-for="(category, key) in availableFonts" :key="key">
        <div v-if="category.fonts.length > 0" class="font-category">
          <div class="font-category-header">{{ category.name }}</div>
          <div 
            v-for="font in category.fonts" 
            :key="font"
            class="font-option"
            :class="{ active: selectedFont === font }"
            @click="selectFont(font)"
            :style="{ fontFamily: font }"
          >
            {{ getFontDisplayName(font) }}
          </div>
        </div>
      </template>
      
      <!-- 备用选项 -->
      <div v-if="Object.keys(availableFonts).length === 0" class="font-category">
        <div class="font-category-header">系统默认</div>
        <div class="font-option" @click="selectFont('Arial')" style="font-family: Arial;">
          Arial
        </div>
        <div class="font-option" @click="selectFont('sans-serif')" style="font-family: sans-serif;">
          Sans Serif
        </div>
      </div>
      
      <!-- EXIF特有选项 -->
      <div v-if="type === 'exif'" class="font-category">
        <div class="font-category-header">EXIF 字体选择</div>
        <div 
          class="font-option"
          :class="{ active: selectedFont === 'follow-text' }"
          @click="selectFont('follow-text')"
          :style="{ fontFamily: followTextFont }"
        >
          跟随文本字体
        </div>
        <div 
          class="font-option"
          :class="{ active: selectedFont === 'Comfortaa' }"
          @click="selectFont('Comfortaa')"
          style="font-family: Comfortaa;"
        >
          Comfortaa
        </div>
        <div 
          class="font-option"
          :class="{ active: selectedFont === 'Times New Roman' }"
          @click="selectFont('Times New Roman')"
          style="font-family: 'Times New Roman';"
        >
          Times New Roman
        </div>
        <div 
          class="font-option"
          :class="{ active: selectedFont === 'Inter' }"
          @click="selectFont('Inter')"
          style="font-family: Inter;"
        >
          Inter
       </div>
        <div 
          class="font-option"
          :class="{ active: selectedFont === 'Cormorant Garamond' }"
          @click="selectFont('Cormorant Garamond')"
          style="font-family: 'Cormorant Garamond';"
        >
          Cormorant Garamond
       </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  selectedFont: {
    type: String,
    required: true
  },
  availableFonts: {
    type: Object,
    required: true
  },
  fontsLoaded: {
    type: Boolean,
    required: true
  },
  isOpen: {
    type: Boolean,
    required: true
  },
  type: {
    type: String,
    default: 'watermark'
  },
  followTextFont: {
    type: String,
    default: 'Arial'
  },
  getFontDisplayName: {
    type: Function,
    required: true
  }
})

const emit = defineEmits(['toggle-dropdown', 'select-font'])

const displayFont = computed(() => {
  if (props.type === 'exif' && props.selectedFont === 'follow-text') {
    return props.followTextFont
  }
  return props.selectedFont
})

const displayName = computed(() => {
  if (props.type === 'exif' && props.selectedFont === 'follow-text') {
    return '跟随文本字体'
  }
  return props.getFontDisplayName(props.selectedFont)
})

const toggleDropdown = () => {
  if (!props.fontsLoaded) return
  emit('toggle-dropdown')
}

const selectFont = (font) => {
  emit('select-font', font)
}
</script>

<style scoped>
.font-selector {
  position: relative;
  width: 100%;
  
  &.disabled {
    opacity: 0.6;
    pointer-events: none;
  }
}

.font-selector-current {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: space-between;
  
  &:hover {
    border-color: rgba(255, 255, 255, 0.5);
    background: rgba(255, 255, 255, 0.15);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  
  .font-display {
    flex: 1;
    text-align: left;
    font-size: 14px;
    font-weight: 500;
  }
  
  .dropdown-arrow {
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
    transition: transform 0.2s ease;
    margin-left: 8px;
  }
  
  &.open .dropdown-arrow {
    transform: rotate(180deg);
  }
}

.font-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 1000;
  background: rgba(74, 63, 54, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
  max-height: 300px;
  overflow-y: auto;
  margin-top: 4px;
  
  &::-webkit-scrollbar {
    width: 6px;
  }
  
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  
  &::-webkit-scrollbar-thumb {
    background: rgba(161, 136, 117, 0.5);
    border-radius: 3px;
    
    &:hover {
      background: rgba(161, 136, 117, 0.7);
    }
  }
}

.font-category {
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  
  &:last-child {
    border-bottom: none;
  }
}

.font-category-header {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  position: sticky;
  top: 0;
  z-index: 1;
}

.font-option {
  padding: 10px 12px;
  color: white;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  
  &:last-child {
    border-bottom: none;
  }
  
  &:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #a18875;
  }
  
  &.active {
    background: rgba(161, 136, 117, 0.3);
    color: #a18875;
    font-weight: 600;
  }
}
</style> 