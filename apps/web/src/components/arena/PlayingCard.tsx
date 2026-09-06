'use client';

import { motion } from 'framer-motion';
import { cardAssetPath, type CardCode } from '@agentholdem/shared';

interface Props {
  card?: CardCode | null;
  /** Renders the CC0 card back instead of a face. */
  faceDown?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Index within a group, used to stagger the deal animation. */
  index?: number;
  dim?: boolean;
}

const SIZES = {
  sm: 'w-9',
  md: 'w-12',
  lg: 'w-[4.25rem]',
} as const;

/** A single card, dealt with a small flip so the board reads as a deal. */
export function PlayingCard({ card, faceDown, size = 'md', index = 0, dim }: Props) {
  const src = faceDown || !card ? '/assets/cards/back.svg' : cardAssetPath(card);

  return (
    <motion.img
      key={src}
      src={src}
      alt={faceDown || !card ? 'Face-down card' : card}
      draggable={false}
      className={`${SIZES[size]} aspect-[240/336] select-none rounded-[7px] shadow-card ${
        dim ? 'opacity-45 saturate-50' : ''
      }`}
      initial={{ opacity: 0, y: -14, rotateY: 90 }}
      animate={{ opacity: 1, y: 0, rotateY: 0 }}
      transition={{ delay: index * 0.07, type: 'spring', stiffness: 220, damping: 22 }}
    />
  );
}
