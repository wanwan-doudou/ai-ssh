/**
 * 水平分隔条组件
 * 
 * 用于调整上下面板的高度比例
 */

import React, { useCallback, useRef, useEffect, useState } from 'react';
import './HorizontalDivider.css';

interface HorizontalDividerProps {
  /** 分隔条位置（底部面板高度，像素） */
  position: number;
  /** 位置变化回调 */
  onPositionChange: (newPosition: number) => void;
  /** 最小高度 */
  minHeight?: number;
  /** 最大高度 */
  maxHeight?: number;
}

export const HorizontalDivider: React.FC<HorizontalDividerProps> = ({
  position,
  onPositionChange,
  minHeight = 100,
  maxHeight = 600,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef<number>(0);
  const startPosition = useRef<number>(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartY.current = e.clientY;
    startPosition.current = position;
  }, [position]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;

    // 向上拖动增加高度，向下拖动减少高度
    const deltaY = dragStartY.current - e.clientY;
    const newPosition = Math.min(maxHeight, Math.max(minHeight, startPosition.current + deltaY));
    onPositionChange(newPosition);
  }, [isDragging, minHeight, maxHeight, onPositionChange]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  return (
    <div
      className={`horizontal-divider ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
    >
      <div className="horizontal-divider-handle" />
    </div>
  );
};

export default HorizontalDivider;
