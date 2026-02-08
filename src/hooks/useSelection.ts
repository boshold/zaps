import { useEffect, useState } from "react";

export function useSelection(itemCount: number) {
  const [index, setIndex] = useState(0);

  // Clamp index when itemCount changes
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, itemCount - 1)));
  }, [itemCount]);

  function moveUp() {
    setIndex((i) => Math.max(0, i - 1));
  }

  function moveDown() {
    setIndex((i) => Math.min(itemCount - 1, i + 1));
  }

  return { index, moveUp, moveDown };
}
