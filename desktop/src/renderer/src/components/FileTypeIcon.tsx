import { FILE_ICON_COLORS, getFileIconType } from "./file-icon";

/// Shared file-type icons (20x20 green rounded-rect with white strokes).
/// Used by clipboard item list, global search, etc.

const ICON_BASE = "flex items-center justify-center w-5 h-5 rounded-[5px] shrink-0";

export function TextIcon() {
  return (
    <div className={ICON_BASE} style={{ backgroundColor: "#00C572" }}>
      <svg width="12" height="12" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M9 5.5V13.5" stroke="#F3F3F3" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M4.5 5.5H9H13.5" stroke="#F3F3F3" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function ImageIcon() {
  return (
    <div className={ICON_BASE} style={{ backgroundColor: "#00C572" }}>
      <svg width="12" height="12" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d="M12.5 14H5.5C4.672 14 4 13.328 4 12.5V5.5C4 4.672 4.672 4 5.5 4H12.5C13.328 4 14 4.672 14 5.5V12.5C14 13.328 13.328 14 12.5 14Z"
          stroke="#F3F3F3"
          strokeWidth="1.2"
        />
        <path
          d="M10.167 8.75L11.376 7.595C11.735 7.253 12.29 7.225 12.681 7.53L13.875 8.458"
          stroke="#F3F3F3"
          strokeWidth="1.167"
          strokeLinecap="round"
        />
        <path
          d="M4 9.8L7.239 7.548L8.184 7.098L11.5 10L11.884 9.561"
          stroke="#F3F3F3"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function FileIcon({ color = "#00C572" }: { color?: string }) {
  return (
    <div className={ICON_BASE} style={{ backgroundColor: color }}>
      <svg width="12" height="12" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path
          d="M5.833 14.267H12.167C12.995 14.267 13.667 13.595 13.667 12.767V5.975C13.667 5.147 12.995 4.475 12.167 4.475H5.833C5.005 4.475 4.333 5.147 4.333 5.975V12.767C4.333 13.595 5.005 14.267 5.833 14.267Z"
          stroke="#F3F3F3"
          strokeWidth="1.2"
          strokeLinecap="square"
        />
        <path d="M7.3 11H10.8" stroke="#F3F3F3" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M7.3 8H10.8" stroke="#F3F3F3" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function LargeFileIcon({ path }: { path: string }) {
  const iconType = getFileIconType(path);
  const color = FILE_ICON_COLORS[iconType];
  const isImage = iconType === "image";
  return (
    <div
      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
      style={{ backgroundColor: `${color}18` }}
    >
      {isImage ? (
        <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path
            d="M12.5 14H5.5C4.672 14 4 13.328 4 12.5V5.5C4 4.672 4.672 4 5.5 4H12.5C13.328 4 14 4.672 14 5.5V12.5C14 13.328 13.328 14 12.5 14Z"
            stroke={color}
            strokeWidth="1.2"
          />
          <path
            d="M10.167 8.75L11.376 7.595C11.735 7.253 12.29 7.225 12.681 7.53L13.875 8.458"
            stroke={color}
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          <circle cx="7" cy="7.5" r="1.2" stroke={color} strokeWidth="1" />
          <path d="M4 12.5L6.5 9.5L8.5 11L10.5 8.5L14 12.5" stroke={color} strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="22" height="22" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path
            d="M5 3h5.586a1 1 0 01.707.293L14 6v9a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z"
            stroke={color}
            strokeWidth="1.2"
          />
          <path d="M10 3v3.5a.5.5 0 00.5.5H14" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
          <path d="M6.5 11h5M6.5 13.5h3" stroke={color} strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}
