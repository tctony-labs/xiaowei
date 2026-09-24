import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export const QUICK_CHAT_TRANSITION_MS = 300;

interface QuickChatTransitionProps {
  expanded: boolean;
  searchHeight?: number;
  composerHeight?: number;
  search: ReactNode;
  composer: ReactNode;
  children: (animating: boolean) => ReactNode;
}

export function QuickChatTransition({
  expanded,
  searchHeight = 71,
  composerHeight = 65,
  search,
  composer,
  children,
}: QuickChatTransitionProps) {
  const previous = useRef(expanded);
  const [retainingChat, setRetainingChat] = useState(expanded);
  const [animating, setAnimating] = useState(false);
  const showChat = expanded || retainingChat;
  const chatHeight = 580 - 6 - composerHeight;

  useLayoutEffect(() => {
    if (previous.current === expanded) return;
    previous.current = expanded;
    setAnimating(true);
    if (expanded) setRetainingChat(true);

    const timer = setTimeout(() => {
      setRetainingChat(expanded);
      setAnimating(false);
    }, QUICK_CHAT_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [expanded]);

  return (
    <div
      data-testid="quick-chat-viewport"
      data-expanded={expanded}
      data-animating={animating}
      className="w-full overflow-hidden bg-transparent px-1 py-0.5"
      style={{ height: expanded ? 580 : searchHeight, transition: "height 300ms ease-out" }}
    >
      <div className="launcher-card relative h-full overflow-hidden rounded-xl border border-line bg-surface">
        <div
          className="absolute inset-x-0 flex flex-col"
          style={{ top: expanded ? 0 : -chatHeight, transition: "top 300ms ease-out" }}
        >
          <div className="shrink-0 overflow-hidden" style={{ height: chatHeight }} inert={!expanded}>
            {showChat && children(animating)}
          </div>
          {showChat ? composer : search}
        </div>
      </div>
    </div>
  );
}
