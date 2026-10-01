export const licenses = Object.fromEntries([
  ['by','Attribution'],['by-sa','Attribution-ShareAlike'],['by-nd','Attribution-NoDerivatives'],
  ['by-nc','Attribution-NonCommercial'],['by-nc-sa','Attribution-NonCommercial-ShareAlike'],['by-nc-nd','Attribution-NonCommercial-NoDerivatives']
].map(([code,name])=>[code,{code,name:name+' 4.0 International',label:'CC '+code.toUpperCase()+' 4.0',url:'https://creativecommons.org/licenses/'+code+'/4.0/'}]));
export const aiDeclaration = {code:'no-generative-ai',label:'未使用生成式 AI（作者自声明）',source:'author'};
