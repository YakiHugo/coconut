/** The island never receives live documents, persistence handles or media nodes. */
export interface CuePreview { readonly id: string; readonly time: string; readonly text: string; readonly current: boolean }
export interface NavigationPage { readonly title: string; readonly page: number; readonly pages: number; readonly total: number; readonly cues: readonly CuePreview[] }
export interface NavigationSession {
  isCurrent(): boolean;
  read(page?: number): NavigationPage | null;
  jump(id: string): boolean;
  jumpTime(value: string): boolean;
  search(): void;
  chapters(): void;
}
export interface NavigationBridge { open(): NavigationSession | null; available(): boolean }
declare global { interface Window { CoconutTranscriptNavigation?: NavigationBridge } }

export interface SelectionActionSession {
 readonly text: string;
 isCurrent(): boolean;
 run(intent: 'explain' | 'translate'): boolean;
 bounds(): {left:number;right:number;top:number;bottom:number} | null;
}
export interface SelectionActionBridge { capture(): SelectionActionSession | null; preview(): SelectionActionSession | null }
declare global { interface Window { CoconutSelectionActions?: SelectionActionBridge } }
