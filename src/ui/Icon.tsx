'use client';

import { useId, type ButtonHTMLAttributes, type CSSProperties } from 'react';

export type IconName =
  | 'add' | 'search' | 'palette' | 'sparkles' | 'file' | 'undo' | 'redo'
  | 'keyboard' | 'activity' | 'cpu' | 'plugins' | 'focus' | 'trash' | 'close'
  | 'copy' | 'cut' | 'paste' | 'group' | 'ungroup' | 'group-membership' | 'maximize' | 'minimize'
  | 'chevron-left' | 'chevron-right' | 'home' | 'save' | 'save-as' | 'folder-open' | 'download'
  | 'snapshot' | 'restore' | 'send' | 'at' | 'check' | 'dismiss' | 'settings' | 'key'
  | 'lock' | 'unlock' | 'sun' | 'moon' | 'reset' | 'command' | 'resize'
  | 'play' | 'stop' | 'more' | 'text' | 'replace' | 'find-replace' | 'paintbrush' | 'word'
  | 'pointer' | 'hand' | 'link' | 'grid' | 'grid-horizontal' | 'grid-vertical'
  | 'font-size' | 'font-weight' | 'line-height' | 'letter-spacing'
  | 'first-indent' | 'paragraph-spacing' | 'text-color'
  | 'spellcheck' | 'autocomplete' | 'comment' | 'globe' | 'echo-8' | 'echo-file' | 'template'
  | 'sync' | 'logout';

export function Icon({
  name,
  size = 17,
  motion = 'none',
}: {
  name: IconName | string;
  size?: number;
  motion?: 'none' | 'sync';
}) {
  if (name === 'echo-8') {
    if (motion === 'sync') return <Echo8SyncIcon size={size} />;
    const width = Math.round(size * 594 / 263);
    return (
      <span
        className="ui-icon echo-8-icon"
        style={{
          '--echo-8-width': `${width}px`,
          '--echo-8-height': `${size}px`,
          backgroundColor: 'currentColor',
          WebkitMaskImage: 'url("/favicon.svg")',
          maskImage: 'url("/favicon.svg")',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
        } as CSSProperties}
        data-icon={name}
        aria-hidden="true"
      />
    );
  }
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      aria-hidden="true"
    >
      {iconPaths(name)}
    </svg>
  );
}

function Echo8SyncIcon({ size }: { size: number }) {
  const width = Math.round(size * 594 / 263);
  const maskId = `echo-8-sync-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  return (
    <svg
      className="ui-icon echo-8-icon echo-8-sync-mark"
      style={{
        '--echo-8-width': `${width}px`,
        '--echo-8-height': `${size}px`,
      } as CSSProperties}
      viewBox="0 0 594 263"
      data-icon="echo-8"
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="13" y="16" width="567" height="230">
          <rect x="13" y="16" width="567" height="230" fill="#fff" />
          <path fill="#000" d="M81 69h430v34H81zM81 157h430v33H81z" />
          <path className="echo-8-sync-gap echo-8-sync-gap-one" fill="#000" d="m226 69 30-53h20l-30 53Z" />
          <path className="echo-8-sync-gap echo-8-sync-gap-two" fill="#000" d="m179 103h21l-31 54h-21Z" />
          <path className="echo-8-sync-gap echo-8-sync-gap-three" fill="#000" d="m256 190h20l-30 56h-20Z" />
        </mask>
      </defs>
      <rect
        className="echo-8-sync-body"
        x="13"
        y="16"
        width="567"
        height="230"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  className = 'icon-button',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title' | 'aria-label'> & {
  icon: IconName | string;
  label: string;
}) {
  return (
    <button {...props} className={className} type={props.type ?? 'button'} aria-label={label} title={label}>
      <Icon name={icon} />
    </button>
  );
}

function iconPaths(name: string) {
  switch (name) {
    case 'add': return <><path d="M12 5v14M5 12h14" /><rect x="3" y="3" width="18" height="18" rx="5" /></>;
    case 'search': return <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>;
    case 'replace': return <><path d="M4 7h12l-3-3m3 3-3 3M20 17H8l3 3m-3-3 3-3" /></>;
    case 'find-replace': return <><path d="M4 6h10m-3-3 3 3-3 3M20 18H10m3-3-3 3 3 3" /><path d="M5 12h4M15 12h4" /></>;
    case 'palette': return <><path d="M12 3a9 9 0 1 0 0 18h1.2a2 2 0 0 0 1.2-3.6 2 2 0 0 1 1.2-3.6H18A3 3 0 0 0 21 11a8 8 0 0 0-9-8Z" /><circle cx="7.5" cy="10" r=".7" /><circle cx="10" cy="6.8" r=".7" /><circle cx="14" cy="6.8" r=".7" /></>;
    case 'sparkles': return <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z" /><path d="m18.5 13 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" /></>;
    case 'file': return <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>;
    case 'home': return <><path d="m3 11 9-8 9 8" /><path d="M5.5 9.5V21h13V9.5M9.5 21v-7h5v7" /></>;
    case 'echo-file': return <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 12h6M9 16h4" /><circle cx="16.8" cy="17.8" r="2.2" /></>;
    case 'save': return <><path d="M5 3h12l3 3v15H4V3z" /><path d="M8 3v6h8V3M8 17h8" /></>;
    case 'save-as': return <><path d="M5 3h11l3 3v7M4 3v18h8" /><path d="M8 3v6h7V3M8 17h3" /><path d="m13.5 18.5 4.8-4.8 2 2-4.8 4.8-2.5.5Z" /></>;
    case 'folder-open': return <><path d="M3 7h7l2 2h9l-2 10H5L3 7Z" /><path d="M3 7V5h7l2 2h7" /></>;
    case 'download': return <><path d="M12 3v12m-4-4 4 4 4-4" /><path d="M5 20h14" /></>;
    case 'paintbrush': return <><path d="m14 4 6 6-8.5 8.5a3 3 0 0 1-4.2 0l-1.8-1.8a3 3 0 0 1 0-4.2L14 4Z" /><path d="m12 6 6 6M5 19c-.2 1.2-1.2 2-2 2 0-.8.8-1.8 2-2Z" /></>;
    case 'word': return <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M8.5 11l1.4 6 2.1-4 2.1 4 1.4-6" /></>;
    case 'template': return <><rect x="4" y="3" width="16" height="18" rx="3" /><path d="M8 8h8M8 12h8M8 16h5" /><path d="m15.5 15.5 1.5-1.5 2 2-1.5 1.5-2.5.5Z" /></>;
    case 'font-size': return <><path d="M3.5 18 8.2 6h1.6l4.7 12M5.5 13h7" /><path d="M16 9h5M18.5 9v9" /></>;
    case 'font-weight': return <><path d="M7 4.5h5.5a4 4 0 0 1 0 8H7zM7 12.5h6a4 4 0 0 1 0 8H7z" /><path d="M7 4v17" /></>;
    case 'line-height': return <><path d="M8 5h12M8 12h12M8 19h12" /><path d="M4 5v14m-2-2 2 2 2-2M2 7l2-2 2 2" /></>;
    case 'letter-spacing': return <><path d="m3 18 4-12 4 12M4.4 14h5.2M13 18l4-12 4 12M14.4 14h5.2" /><path d="M9 21h6m-4-2-2 2 2 2m2-4 2 2-2 2" /></>;
    case 'first-indent': return <><path d="M9 5h11M4 10h16M4 15h16M4 20h16" /><path d="m4 5 3-2v4Z" /></>;
    case 'paragraph-spacing': return <><path d="M4 4h16M4 8h16M4 16h16M4 20h16" /><path d="M12 10v4m-2-2 2 2 2-2m-4 0 2-2 2 2" /></>;
    case 'text-color': return <><path d="m5 17 5-12h2l5 12M7 13h8" /><path d="M4 21h16" /></>;
    case 'spellcheck': return <><path d="M4 16 8.5 5h2L15 16M6 12h7" /><path d="m14.5 18 2.2 2.2L21 15.8" /></>;
    case 'autocomplete': return <><path d="M4 17 8.2 6h1.6L14 17M5.5 13h7" /><path d="M17 6v12M15 6h4M15 18h4" /></>;
    case 'comment': return <><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="M7 9h10M7 13h7" /></>;
    case 'globe': return <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>;
    case 'undo': return <><path d="m9 7-5 5 5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" /></>;
    case 'redo': return <><path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" /></>;
    case 'keyboard': return <><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 14h10" /></>;
    case 'activity': return <><path d="M3 12h4l2-6 4 12 2-6h6" /></>;
    case 'cpu': return <><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" /><circle cx="12" cy="12" r="2" /></>;
    case 'plugins': return <><path d="M8 3v4m8-4v4M6 7h12v4a6 6 0 0 1-12 0V7Z" /><path d="M12 17v4" /></>;
    case 'focus': return <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5m13 5h5v-5" /><circle cx="12" cy="12" r="3" /></>;
    case 'trash': return <><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7" /><path d="M10 11v6m4-6v6" /></>;
    case 'key': return <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" /></>;
    case 'close': return <path d="m6 6 12 12M18 6 6 18" />;
    case 'copy': return <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>;
    case 'cut': return <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="m8.5 7.5 11 7M8.5 16.5l11-7" /></>;
    case 'paste': return <><path d="M9 5h6l1 3H8l1-3Z" /><path d="M8 7H5v14h14V7h-3" /></>;
    case 'group': return <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="8.5" y="14" width="7" height="7" rx="2" /><path d="M6.5 10v2h11v-2M12 12v2" /></>;
    case 'ungroup': return <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /><path d="m14 5 5 5m0-5-5 5M5 14l5 5m-5 0 5-5" /></>;
    case 'group-membership': return <><rect x="3" y="4" width="11" height="16" rx="3" /><path d="M8.5 8v8M4.5 12h8" /><path d="M17 8h4M19 6v4M17 16h4" /></>;
    case 'maximize': return <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5m13 5h5v-5" /></>;
    case 'minimize': return <path d="M5 12h14" />;
    case 'chevron-left': return <path d="m15 18-6-6 6-6" />;
    case 'chevron-right': return <path d="m9 18 6-6-6-6" />;
    case 'snapshot': return <><path d="M4 7h4l2-3h4l2 3h4v13H4z" /><circle cx="12" cy="13" r="4" /></>;
    case 'restore': return <><path d="M4 12a8 8 0 1 0 2-5.3L4 9" /><path d="M4 4v5h5M12 8v5l3 2" /></>;
    case 'send': return <><path d="m3 3 18 9-18 9 4-9-4-9Z" /><path d="M7 12h14" /></>;
    case 'at': return <><circle cx="12" cy="12" r="9" /><path d="M16 12v-2a4 4 0 1 0-1.2 2.8C16.5 14 19 13 19 10" /></>;
    case 'check': return <path d="m5 12 4 4L19 6" />;
    case 'dismiss': return <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>;
    case 'settings': return <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.5 6A8 8 0 0 0 9 7L6.6 6 4.6 9.5 6.8 11a7 7 0 0 0 0 2l-2.2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.5 1l.2 2.6h4L15 18a8 8 0 0 0 1.5-1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" /></>;
    case 'lock': return <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>;
    case 'unlock': return <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 7-2" /></>;
    case 'sun': return <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" /></>;
    case 'moon': return <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />;
    case 'reset': return <><path d="M4 12a8 8 0 1 0 2-5.5L4 9" /><path d="M4 4v5h5" /></>;
    case 'sync': return <><path d="M20 7h-5V2" /><path d="M20 7a8 8 0 0 0-14-2" /><path d="M4 17h5v5" /><path d="M4 17a8 8 0 0 0 14 2" /></>;
    case 'logout': return <><path d="M10 4H5v16h5" /><path d="M13 8l4 4-4 4M8 12h9" /></>;
    case 'command': return <><path d="M9 6V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z" /></>;
    case 'resize': return <path d="m12 18 6-6M7 18 18 7" />;
    case 'play': return <path d="m8 5 11 7-11 7V5Z" />;
    case 'stop': return <rect x="6" y="6" width="12" height="12" rx="2" />;
    case 'text': return <><path d="M5 5h14M12 5v14M8 19h8" /></>;
    case 'pointer': return <><path d="m5 3 14 9-7 2-3 7L5 3Z" /><path d="m12 14 4 5" /></>;
    case 'hand': return <><path d="M8 11V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v8c0 5-3 7-7 7h-1c-3 0-5-1.5-7-4l-2-3a2 2 0 0 1 3-2l2 2" /></>;
    case 'link': return <><path d="M9.5 14.5 14.5 9" /><path d="M7.5 17H6a4 4 0 0 1 0-8h3M16.5 7H18a4 4 0 0 1 0 8h-3" /></>;
    case 'grid': return <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>;
    case 'grid-horizontal': return <><rect x="3" y="5" width="5" height="5" rx="1" /><rect x="9.5" y="5" width="5" height="5" rx="1" /><rect x="16" y="5" width="5" height="5" rx="1" /><path d="M5.5 15h13m-3-3 3 3-3 3" /></>;
    case 'grid-vertical': return <><rect x="5" y="3" width="5" height="5" rx="1" /><rect x="5" y="9.5" width="5" height="5" rx="1" /><rect x="5" y="16" width="5" height="5" rx="1" /><path d="M15 5.5v13m-3-3 3 3 3-3" /></>;
    case 'more': return <><circle cx="6" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1" fill="currentColor" stroke="none" /></>;
    default: return <circle cx="12" cy="12" r="7" />;
  }
}
