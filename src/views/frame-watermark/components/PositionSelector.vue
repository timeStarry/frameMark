<template>
  <div class="position-selector">
    <!-- 九宫格位置选择 -->
    <div v-if="type === 'grid'" class="position-grid">
      <div 
        v-for="position in positionOptions" 
        :key="position.value"
        class="position-cell"
        :class="{ active: selectedPosition === position.value }"
        @click="selectPosition(position.value)"
        :title="position.label"
      >
        <div class="position-dot"></div>
      </div>
    </div>
    
    <!-- 底边条幅位置选择 -->
    <select 
      v-else-if="type === 'bottom-bar'"
      :value="selectedPosition"
      @change="selectPosition($event.target.value)"
      class="bottom-bar-select"
    >
      <option value="left">条幅左侧</option>
      <option value="center">条幅中心</option>
      <option value="right">条幅右侧</option>
    </select>
  </div>
</template>

<script setup>
const props = defineProps({
  type: {
    type: String,
    required: true,
    validator: (value) => ['grid', 'bottom-bar'].includes(value)
  },
  selectedPosition: {
    type: String,
    required: true
  },
  positionOptions: {
    type: Array,
    required: true
  }
})

const emit = defineEmits(['select-position'])

const selectPosition = (position) => {
  emit('select-position', position)
}
</script>

<style scoped>
.position-selector {
  width: 100%;
}

/* 九宫格位置选择器样式 */
.position-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  width: 120px;
  height: 120px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 8px;
  margin-top: 4px;
}

.position-cell {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  position: relative;
  
  &:hover {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.4);
    transform: scale(1.05);
  }
  
  &.active {
    background: #a18875;
    border-color: #a18875;
    box-shadow: 0 0 8px rgba(161, 136, 117, 0.5);
    
    .position-dot {
      background: white;
      transform: scale(1.2);
    }
  }
}

.position-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.6);
  transition: all 0.3s ease;
}

/* 底边条幅选择器样式 */
.bottom-bar-select {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: white;
  font-size: 14px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  transition: all 0.2s ease;
  cursor: pointer;
  
  &:focus {
    outline: none;
    border-color: #a18875;
    background: rgba(255, 255, 255, 0.15);
  }
  
  &:hover {
    border-color: rgba(255, 255, 255, 0.5);
    background: rgba(255, 255, 255, 0.15);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  
  option {
    background: #4a3f36;
    color: white;
    padding: 8px 12px;
    border: none;
    
    &:hover {
      background: #5d5148;
    }
    
    &:checked {
      background: #a18875;
      color: white;
    }
  }
}
</style> 