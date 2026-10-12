/** The native chooser validates these authored bytes again at ingress. Keep the
 * fixture canonical too, rather than assuming object insertion is fallback order. */
import C from '../../reader/core.js';
import {displayedTranslationExportsFixture} from './displayed-translation-exports-fixture.mjs';
export function readingDisplayFixture(options={}){
 const doc=displayedTranslationExportsFixture(options);
 for(const cue of doc.segments){
  cue.translations.fr.text+=' Une phrase française beaucoup plus longue pour vérifier le déplacement des lignes.'.repeat(10);
  for(const code of ['en','ja','ko','de','es'])cue.translations[code]={...cue.translations.fr,text:code+' authored saved reading '+cue.id};
 }
 doc.readingPosition='cue-3';doc.segments[0].end=20;
 return {...C.validate(doc),key:doc.key};
}
