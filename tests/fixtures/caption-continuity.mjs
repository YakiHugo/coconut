import {createCaptionService} from '../../desktop/caption-service.mjs';
import {createIngestionService} from '../../desktop/ingestion-service.mjs';
import {captionFixtureURL,captionFixtureResult} from '../helpers/caption-diagnostics-fixtures.mjs';
export {captionFixtureURL};
export function captionContinuityFixture(){
 const state={mode:'language',hold:null},requests=[];
 const captions=createCaptionService({enabledProviders:['x'],helper:{extractCaptions:async request=>{
  requests.push({url:request.url,language:request.language});if(state.hold)await state.hold;
  if(state.mode==='language'&&!request.language)return {status:'language_required',languages:['en','fr']};
  if(state.mode==='missing_choices')return {status:'language_required'};
  return captionFixtureResult({complete:state.mode==='clean'||state.mode==='language',onlyInvalid:state.mode==='fatal'});
 }}});
 return {state,requests,captions,service:createIngestionService({captionService:captions})};
}
