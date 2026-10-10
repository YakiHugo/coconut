// All prose here is authored solely for deterministic review acceptance.
export function translationReviewFixture(count=105){
 return {title:'Authored translation review',language:'en',translation_view:'zh',notes:{},segments:Array.from({length:count},(_,i)=>{
  const text=`Authored source ${i}. Keep ${i+1} apples.`;
  const segment={id:'review-'+i,start:i*4,end:i*4+3,text,speaker:'Author',saved_excerpt:i===102};
  if(i!==0)segment.translations={zh:{text:i===102?'旧译文 <script> 7 个苹果\n第二行':'作者译文 '+i,source_text:i===102?'Old authored source.':text,source_language:'en',document_language:'en',provider:'authored_fixture',...(i===1?{quality_warnings:['numbers_changed']}: {})}};
  if(i===2)segment.translations.ja={text:'作者による訳文',source_text:'Earlier source',source_language:'en',provider:'authored_fixture'};
  return segment;
 })};
}
