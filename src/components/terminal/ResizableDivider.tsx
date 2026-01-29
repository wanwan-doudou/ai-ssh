import { useRef, useCallback } from 'react';

interface ResizableDividerProps {
  // 当前面板比例（右侧面板占总宽度的比例）
  ratio: number;
  // 比例变化回调
  onRatioChange: (ratio: number) => void;
  // 容器宽度（用于计算比例）
  containerWidth: number;
  // 左侧面板最小宽度 (px)
  minLeftWidth?: number;
  // 拖拽开始回调
  onDragStart?: () => void;
  // 拖拽结束回调
  onDragEnd?: () => void;
}

export function ResizableDivider({ ratio, onRatioChange, containerWidth, minLeftWidth = 0, onDragStart, onDragEnd }: ResizableDividerProps) {
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startRatio = useRef(ratio);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startRatio.current = ratio;
    
    // 通知父组件拖拽开始
    onDragStart?.();
    
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current || containerWidth === 0) return;
      
      const deltaX = startX.current - moveEvent.clientX;
      const deltaRatio = deltaX / containerWidth;

      // 计算允许的最大比例（确保左侧至少保留 minLeftWidth）
      // 默认最大限制为 0.6 (60%)
      // 公式: (1 - maxRatio) * containerWidth >= minLeftWidth
      // => 1 - maxRatio >= minLeftWidth / containerWidth
      // => maxRatio <= 1 - minLeftWidth / containerWidth
      
      let maxRatio = 0.6;
      if (minLeftWidth > 0 && containerWidth > minLeftWidth) {
        const widthBasedMaxRatio = 1 - (minLeftWidth / containerWidth);
        maxRatio = Math.min(0.6, widthBasedMaxRatio);
      }

      const newRatio = Math.max(0.2, Math.min(maxRatio, startRatio.current + deltaRatio));
      
      onRatioChange(newRatio);
    };
    
    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      
      // 通知父组件拖拽结束
      onDragEnd?.();
      
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [ratio, onRatioChange, containerWidth, onDragStart, onDragEnd]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1.5 h-full flex-shrink-0 bg-surface-200 dark:bg-surface-800 hover:bg-primary-500/50 
                 cursor-col-resize transition-colors duration-150 
                 flex items-center justify-center group border-l border-r border-transparent dark:border-transparent"
      title="拖拽调整面板宽度"
    >
      {/* 拖拽指示器 */}
      <div className="w-0.5 h-8 bg-surface-400 dark:bg-surface-600 group-hover:bg-primary-400 
                      rounded-full transition-colors duration-150" />
    </div>
  );
}
