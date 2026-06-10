interface ScoreRingProps {
  score: number;
  size?: number;
}

export default function ScoreRing({ score, size = 52 }: ScoreRingProps) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;
  const gap = circumference - filled;

  const getColor = (s: number) => {
    if (s >= 88) return "#10b981"; // emerald — matches must_post threshold
    if (s >= 70) return "#3b82f6"; // blue
    if (s >= 55) return "#f59e0b"; // amber
    return "#ef4444"; // red
  };

  const color = getColor(score);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="oklch(0.25 0.015 240)"
          strokeWidth={4}
        />
        {/* Fill */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeDasharray={`${filled} ${gap}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.5s cubic-bezier(0.23,1,0.32,1)" }}
        />
      </svg>
      <div
        className="absolute inset-0 flex items-center justify-center font-bold text-sm"
        style={{ color, fontFamily: "Space Grotesk, sans-serif" }}
      >
        {score}
      </div>
    </div>
  );
}
