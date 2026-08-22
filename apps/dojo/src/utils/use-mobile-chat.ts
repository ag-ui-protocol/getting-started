import React, { useEffect, useState } from "react";


export function useMobileChat(defaultChatHeight = 50) {
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatHeight, setChatHeight] = useState(defaultChatHeight); // Initial height as percentage
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartY, setDragStartY] = useState(0);
  const [dragStartHeight, setDragStartHeight] = useState(defaultChatHeight);

  // Drag functionality for chat resize
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const deltaY = dragStartY - e.clientY;
      const windowHeight = window.innerHeight;
      const newHeightPx = (dragStartHeight / 100) * windowHeight + deltaY;
      const newHeightPercent = (newHeightPx / windowHeight) * 100;

      // Clamp between 50% and 100%
      const clampedHeight = Math.max(50, Math.min(100, newHeightPercent));
      setChatHeight(clampedHeight);
    };

    const handleMouseUp = () => {
      if (isDragging) {
        // Close if dragged below 50%
        if (chatHeight < 50) {
          setIsChatOpen(false);
          setChatHeight(defaultChatHeight); // Reset to default
        }
        setIsDragging(false);
      }
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = 'none'; // Prevent text selection while dragging
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
    };
  }, [isDragging, dragStartY, dragStartHeight, chatHeight, defaultChatHeight]);

  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStartY(e.clientY);
    setDragStartHeight(chatHeight);
  };

  return {
    isChatOpen,
    setChatHeight,
    setIsChatOpen,
    isDragging,
    chatHeight,
    handleDragStart
  }
}