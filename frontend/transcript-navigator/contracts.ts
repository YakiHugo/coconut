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
