/* Driveway Finds core logic: pure functions with no DOM access.
   Loaded by index.html as window.DF and by the tests as a CommonJS module. */
(function(root,factory){
  var api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;else root.DF=api;
})(typeof self!=="undefined"?self:this,function(){
"use strict";

var FIELDS=["vehicles","yearMin","yearMax","body","drive","cyl","engine","fuel","trans","kw","priceMin","priceMax","milesMax","zip","dist"];
var LABELS={body:{"7":"Pickup","10":"SUV","8":"Sedan","3":"Coupe","4":"Hatchback","11":"Wagon","12":"Van","5":"Minivan","2":"Convertible","6":"Off-road"},
  drive:{"3":"4x4","2":"RWD","1":"FWD"},cyl:{"2":"4 cyl","4":"6 cyl","5":"8 cyl","6":"10 cyl"},fuel:{"1":"Gas","2":"Diesel","3":"Hybrid","4":"Electric"},trans:{"2":"Automatic","1":"Manual"}};
var FILTER_NAMES={yearMin:"year",yearMax:"year",body:"body style",drive:"drive",cyl:"cylinders",engine:"engine",fuel:"fuel",trans:"transmission",kw:"keywords",priceMin:"min price",priceMax:"max price",milesMax:"mileage",zip:"ZIP and distance"};
var STAGES=[["","No stage yet"],["contacted","Contacted seller"],["testdrive","Test drive set"],["inspected","Inspected"],["offer","Offer made"],["passed","Passed on it"]];

/* ---------- small helpers ---------- */
function money(n){return (n||n===0)&&!isNaN(n)?"$"+Number(n).toLocaleString("en-US"):""}
function num(v){if(v===null||v===undefined||v==="")return null;var n=parseFloat(v);return isNaN(n)?null:n}
function slug(s,fallback){s=String(s||"").toLowerCase().replace(/[^a-z0-9-]/g,"");return s||fallback}
function safeUrl(u){try{var x=new URL(String(u));return (x.protocol==="https:"||x.protocol==="http:")?x.href:null}catch(e){return null}}

/* ---------- vehicles ---------- */
function vtext(c){if(c.vehicles!=null&&c.vehicles!=="")return String(c.vehicles);return [c.make,c.model].filter(Boolean).join(" ")}
function vlist(c){var seen={};return vtext(c).split(/[,;\n]+/).map(function(s){return s.replace(/\s+/g," ").trim()}).filter(function(s){var k=s.toLowerCase();if(!s||seen[k])return false;seen[k]=1;return true})}

/* Makes whose name is more than one word, plus common nicknames. Keys are lower case, single spaced. */
var MULTI_MAKES=["land rover","alfa romeo","aston martin","mercedes benz","rolls royce","am general"];
var MAKE_ALIASES={chevy:"chevrolet",vw:"volkswagen",mercedes:"mercedes benz","mercedes-benz":"mercedes benz",benz:"mercedes benz",landrover:"land rover","range rover":"land rover",caddy:"cadillac"};
/* Split "Land Rover Defender" into {make:"land rover",model:"defender"}.
   "Range Rover Sport" is a Land Rover model, so it keeps "range rover" in the model. */
function splitVehicle(v){
  var s=String(v||"").toLowerCase().replace(/\s+/g," ").trim();if(!s)return {make:"",model:""};
  if(/^range rover\b/.test(s))return {make:"land rover",model:s};
  var flat=s.replace(/-/g," ");
  for(var i=0;i<MULTI_MAKES.length;i++){var m=MULTI_MAKES[i];
    if(flat===m||flat.indexOf(m+" ")===0)return {make:m,model:s.slice(m.length).trim()}}
  var parts=s.split(" "),first=parts[0];
  return {make:MAKE_ALIASES[first]||first,model:parts.slice(1).join(" ")};
}

/* ---------- search summary ---------- */
function title(c){var t=vlist(c).join(", ");
  if(!t)t=LABELS.body[c.body]?("Any "+LABELS.body[c.body]):"Any vehicle";return t}
function chipList(c){var out=[];
  if(c.yearMin||c.yearMax)out.push((c.yearMin||"any")+" to "+(c.yearMax||"now"));
  if(vlist(c).length){if(LABELS.body[c.body])out.push(LABELS.body[c.body])}
  ["drive","cyl","fuel","trans"].forEach(function(k){if(LABELS[k][c[k]])out.push(LABELS[k][c[k]])});
  if(c.engine)out.push(c.engine);
  if(c.kw)out.push(c.kw);
  if(c.priceMin||c.priceMax)out.push((c.priceMin?money(c.priceMin):"$0")+" to "+(c.priceMax?money(c.priceMax):"any"));
  if(c.milesMax)out.push("under "+Number(c.milesMax).toLocaleString("en-US")+" mi");
  if(c.dist==="any")out.push("Anywhere in the US");else if(c.zip)out.push(Number(c.dist).toLocaleString("en-US")+" mi of "+c.zip);
  return out}

/* Two searches are the same when every field matches, ignoring case, spacing and vehicle order. */
function criteriaKey(c){c=c||{};var o={};
  FIELDS.forEach(function(k){var v=String(c[k]==null?"":c[k]).trim().toLowerCase().replace(/\s+/g," ");o[k]=v});
  o.vehicles=vlist(c).map(function(s){return s.toLowerCase()}).sort().join("|");
  if(!o.dist)o.dist="50";
  return JSON.stringify(o)}
function sameCriteria(a,b){return criteriaKey(a)===criteriaKey(b)}

/* ---------- link builders ---------- */
/* Which filters each site actually applies. Anything set but not listed is skipped by that site. */
var SUPPORTS={
  facebook:["yearMin","yearMax","drive","fuel","engine","kw","priceMin","priceMax","milesMax"],
  craigslist:["yearMin","yearMax","body","drive","cyl","engine","fuel","trans","kw","priceMin","priceMax","milesMax","zip"],
  autotempest:["yearMin","yearMax","priceMin","priceMax","milesMax","zip"],
  carscom:["yearMin","yearMax","priceMax","milesMax","zip"],
  offerup:["engine","kw","priceMin","priceMax"]
};
/* Facebook only understands two values as words: 4x4 and diesel. */
function skippedFilters(site,c){
  var ok=SUPPORTS[site]||[],seen={},out=[];
  Object.keys(FILTER_NAMES).forEach(function(k){
    var v=c[k];if(v==null||v==="")return;
    var used=ok.indexOf(k)>=0;
    if(site==="facebook"&&k==="drive"&&v!=="3")used=false;
    if(site==="facebook"&&k==="fuel"&&v!=="2")used=false;
    if(k==="zip"&&c.dist==="any")return;
    var n=FILTER_NAMES[k];if(!used&&!seen[n]){seen[n]=1;out.push(n)}});
  return out}

function fbUrl(c,s,vehicle){
  var words=[vehicle,c.drive==="3"?"4x4":"",c.fuel==="2"?"diesel":"",c.engine,c.kw].filter(Boolean).join(" ");
  var p=new URLSearchParams();
  if(words)p.set("query",words);
  if(c.priceMin)p.set("minPrice",c.priceMin);
  if(c.priceMax)p.set("maxPrice",c.priceMax);
  if(c.yearMin)p.set("minYear",c.yearMin);
  if(c.yearMax)p.set("maxYear",c.yearMax);
  if(c.milesMax)p.set("maxMileage",c.milesMax);
  p.set("sellerType","individual");
  p.set("topLevelVehicleType","car_truck");
  p.set("sortBy","creation_time_descend");
  p.set("exact","false");
  return "https://www.facebook.com/marketplace/"+slug(s.fbCity,"pittsburgh")+"/"+(words?"search":"vehicles")+"?"+p.toString();
}
function fbLinks(c,s){var v=vlist(c);if(!v.length)return [{label:"",url:fbUrl(c,s,"")}];
  return v.map(function(x){return {label:x,url:fbUrl(c,s,x)}})}

function atUrl(c,vehicle){
  var p=new URLSearchParams();var mm=splitVehicle(vehicle);
  if(mm.make)p.set("make",mm.make.replace(/[^a-z0-9]/g,""));
  if(mm.model)p.set("model",mm.model.replace(/\s+/g,""));
  if(/^\d{5}$/.test(c.zip))p.set("zip",c.zip);
  var d=Number(c.dist)||50,allowed=[25,50,100,300,500,1000],r=allowed.filter(function(x){return x>=d})[0]||1000;p.set("radius",c.dist==="any"?"any":String(r));
  if(c.yearMin)p.set("minyear",c.yearMin);if(c.yearMax)p.set("maxyear",c.yearMax);
  if(c.priceMin)p.set("minprice",c.priceMin);if(c.priceMax)p.set("maxprice",c.priceMax);
  if(c.milesMax)p.set("maxmiles",c.milesMax);
  return "https://www.autotempest.com/results?"+p.toString();
}

function clUrl(c,s,site){
  var p=new URLSearchParams();
  var v=vlist(c),group="";
  if(v.length===1)p.set("auto_make_model",v[0]);
  else if(v.length>1)group=v.map(function(x){return x.indexOf(" ")>=0?"("+x+")":x}).join("|");
  var q=[group,c.engine,c.kw].filter(Boolean).join(" ");
  if(q)p.set("query",q);
  if(c.priceMin)p.set("min_price",c.priceMin);
  if(c.priceMax)p.set("max_price",c.priceMax);
  if(c.yearMin)p.set("min_auto_year",c.yearMin);
  if(c.yearMax)p.set("max_auto_year",c.yearMax);
  if(c.milesMax)p.set("max_auto_miles",c.milesMax);
  if(c.body)p.set("auto_bodytype",c.body);
  if(c.drive)p.set("auto_drivetrain",c.drive);
  if(c.cyl)p.set("auto_cylinders",c.cyl);
  if(c.fuel)p.set("auto_fuel_type",c.fuel);
  if(c.trans)p.set("auto_transmission",c.trans);
  if(/^\d{5}$/.test(c.zip)&&c.dist!=="any"){p.set("postal",c.zip);p.set("search_distance",String(Math.min(Number(c.dist)||50,500)))}
  p.set("bundleDuplicates","1");
  p.set("sort","date");
  return "https://"+slug(site||s.clSite,"pittsburgh")+".craigslist.org/search/cto?"+p.toString();
}
/* The main Craigslist site first, then any nearby sites from settings, without repeats. */
function clSites(s){var seen={},out=[];
  [s.clSite].concat(String(s.clExtra||"").split(/[,;\s]+/)).forEach(function(x){x=slug(x,"");if(x&&!seen[x]){seen[x]=1;out.push(x)}});
  if(!out.length)out.push("pittsburgh");return out}

/* Cars.com uses make slugs like "land_rover" and model slugs like "ford-f_150". */
function carsSlug(s){return String(s).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")}
function carsUrl(c,vehicle){
  var p=new URLSearchParams();var mm=splitVehicle(vehicle);
  p.set("stock_type","used");
  if(mm.make){var mk=carsSlug(mm.make);p.append("makes[]",mk);if(mm.model)p.append("models[]",mk+"-"+carsSlug(mm.model))}
  if(c.yearMin)p.set("year_min",c.yearMin);if(c.yearMax)p.set("year_max",c.yearMax);
  if(c.priceMax)p.set("list_price_max",c.priceMax);
  if(c.milesMax)p.set("mileage_max",c.milesMax);
  if(/^\d{5}$/.test(c.zip)){p.set("zip",c.zip);
    var d=c.dist==="any"?500:(Number(c.dist)||50),allowed=[10,25,50,75,100,200,500];p.set("maximum_distance",String(allowed.filter(function(x){return x>=d})[0]||500))}
  p.set("sort","listed_at_desc");
  return "https://www.cars.com/shopping/results/?"+p.toString();
}
function offerupUrl(c,vehicle){
  var p=new URLSearchParams();
  var q=[vehicle,c.engine,c.kw].filter(Boolean).join(" ");
  p.set("q",q||"car truck");
  if(c.priceMin)p.set("PRICE_MIN",c.priceMin);
  if(c.priceMax)p.set("PRICE_MAX",c.priceMax);
  return "https://offerup.com/search?"+p.toString();
}

/* ---------- listings ---------- */
var SITES=[["cars.com","Cars.com"],["autotrader.com","Autotrader"],["cargurus.com","CarGurus"],["carmax.com","CarMax"],["carvana.com","Carvana"],["truecar.com","TrueCar"],["edmunds.com","Edmunds"],["ebay.com","eBay Motors"],["carsandbids.com","Cars & Bids"],["bringatrailer.com","Bring a Trailer"],["hemmings.com","Hemmings"],["autotempest.com","AutoTempest"],["facebook.com","Facebook"],["craigslist.org","Craigslist"],["offerup.com","OfferUp"],["copart.com","Copart"],["iaai.com","IAA"],["acvauctions.com","ACV"],["kbb.com","Kelley Blue Book"],["carfax.com","Carfax"],["cargurus.ca","CarGurus"],["privateauto.com","PrivateAuto"],["carsoup.com","CarSoup"],["carsdirect.com","CarsDirect"],["vroom.com","Vroom"]];
function siteOf(u){try{var h=new URL(u).hostname.replace(/^www\./,"").toLowerCase();
  for(var i=0;i<SITES.length;i++){if(h===SITES[i][0]||h.slice(-SITES[i][0].length-1)==="."+SITES[i][0])return SITES[i][1]}
  return h}catch(e){return ""}}
function guessTitle(u){try{var segs=new URL(u).pathname.split("/").filter(Boolean).map(decodeURIComponent);var best="";
  segs.forEach(function(s){var t=s.replace(/\.[a-z]{2,5}$/i,"");if(/[a-z]{3}/i.test(t)&&/[-_+]/.test(t)&&t.length>best.length&&!/^(vehicledetail|marketplace|item|listing|vehicle|cars?|used|detail|details)$/i.test(t))best=t});
  if(!best||!/\b(19[5-9]\d|20[0-3]\d)\b/.test(best.replace(/[-_+]+/g," ")))return "";var w=best.replace(/[-_+]+/g," ").replace(/\b[0-9a-f]{8,}\b/gi,"").replace(/\s+/g," ").trim();
  return w.replace(/\b([a-z])([a-z]*)/g,function(m,a,b){return a.toUpperCase()+b})}catch(e){return ""}}
function detectTitle(t){t=String(t||"").toLowerCase();
  if(/\b(no|not|never|non|without)\W+(a\W+|any\W+)?(salvage|salvaged|rebuilt)\b/.test(t))return "";
  if(/\b(salvage|salvaged)\b|junk title|total loss|flood (damage|title|car)|parts only/.test(t))return "salvage";
  if(/\b(rebuilt|reconstructed|branded)\b\W{0,3}(title|status)|\btitle\W{0,3}(rebuilt|reconstructed|branded)\b|\brebuilt\/salvage|\bsalvage\/rebuilt/.test(t))return "rebuilt";
  return ""}

/* A stable form of a listing link, used to spot the same listing pasted twice.
   Drops tracking parameters, the #fragment, "www." and a trailing slash.
   Facebook item links shrink to their item number. */
var TRACKING=/^(utm_.*|fbclid|gclid|msclkid|ref|refid|referral_code|referral_story_type|tracking|trk|mibextid|share_id|rdid|sfnsn|_ga|mc_cid|mc_eid)$/i;
function normUrl(u){try{var x=new URL(String(u).trim());if(x.protocol!=="https:"&&x.protocol!=="http:")return "";
  var host=x.hostname.toLowerCase().replace(/^(www|m|mobile)\./,"");
  var fb=/(^|\.)facebook\.com$/.test(host)&&x.pathname.match(/\/marketplace\/item\/(\d+)/);
  if(fb)return "facebook.com/marketplace/item/"+fb[1];
  var keep=[];x.searchParams.forEach(function(v,k){if(!TRACKING.test(k))keep.push([k,v])});
  keep.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0});
  var qs=keep.map(function(p){return encodeURIComponent(p[0])+"="+encodeURIComponent(p[1])}).join("&");
  return host+x.pathname.replace(/\/+$/,"")+(qs?"?"+qs:"")}catch(e){return ""}}
function findByUrl(finds,u){var k=normUrl(u);if(!k)return null;
  for(var i=0;i<finds.length;i++){if(normUrl(finds[i].url)===k)return finds[i]}return null}

/* Cost per remaining mile: price divided by (lifespan minus odometer). */
function cpm(f,lifespan){var p=num(f.price),m=num(f.miles),L=Number(lifespan)||200000;return (p>0&&m!=null&&m>=0&&m<L)?p/(L-m):null}
function budgetGap(f,searches){var s=(searches||[]).find(function(x){return x.id===f.searchId});var max=s&&s.criteria?num(s.criteria.priceMax):null;var p=num(f.price);
  if(!max||p==null||p<=0)return null;return Math.round((max-p)/max*100)}

/* ---------- price history ---------- */
/* Returns the history after a price edit. Only records real changes. */
function withPrice(history,oldPrice,newPrice,at){
  var h=Array.isArray(history)?history.slice():[];
  oldPrice=num(oldPrice);newPrice=num(newPrice);
  if(!h.length&&oldPrice!=null)h.push({price:oldPrice,at:at});
  if(newPrice!=null&&newPrice!==oldPrice)h.push({price:newPrice,at:at});
  return h}
/* First recorded price minus the current one. Positive means the price dropped. */
function priceChange(f){var h=Array.isArray(f.priceHistory)?f.priceHistory:[];var now=num(f.price);
  if(!h.length||now==null)return null;var first=num(h[0].price);if(first==null||first===now)return null;
  return {from:first,to:now,drop:first-now}}

/* ---------- VIN ---------- */
var VIN_VALUES={A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9};
var VIN_WEIGHTS=[8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
function cleanVin(v){return String(v||"").toUpperCase().replace(/[\s-]/g,"")}
/* Shape check: 17 characters, no I, O or Q. checkDigit tells whether the 9th character matches,
   which every North American vehicle from 1981 on must pass. */
function checkVin(v){v=cleanVin(v);
  if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(v))return {ok:false,vin:v,checkDigit:false};
  var sum=0;for(var i=0;i<17;i++){var ch=v[i];var val=/\d/.test(ch)?Number(ch):VIN_VALUES[ch];sum+=val*VIN_WEIGHTS[i]}
  var r=sum%11,expect=r===10?"X":String(r);
  return {ok:true,vin:v,checkDigit:v[8]===expect}}
/* Pull a VIN out of a link or a block of text, if one is there and passes the check digit. */
function findVin(text){var m=String(text||"").toUpperCase().match(/(^|[^A-Z0-9])([A-HJ-NPR-Z0-9]{17})(?![A-Z0-9])/g);if(!m)return "";
  for(var i=0;i<m.length;i++){var c=m[i].replace(/^[^A-Z0-9]/,"");if(/\d/.test(c)&&/[A-Z]/.test(c)&&checkVin(c).checkDigit)return c}return ""}
function titleCase(s){return String(s||"").toLowerCase().replace(/\b([a-z])/g,function(m){return m.toUpperCase()})}
/* Turn one NHTSA vPIC DecodeVinValues result into the fields this app keeps. */
function parseVpic(json){
  var r=json&&json.Results&&json.Results[0];if(!r)return null;
  var year=num(r.ModelYear),make=r.Make?titleCase(r.Make):"",model=r.Model||"";
  if(!year&&!make&&!model)return null;
  var eng=[];var L=num(r.DisplacementL);if(L)eng.push(L.toFixed(1)+"L");if(r.EngineCylinders)eng.push(r.EngineCylinders+" cyl");if(r.EngineModel)eng.push(r.EngineModel);
  var drive=String(r.DriveType||"");
  var specs=[eng.join(" "),drive,r.FuelTypePrimary,r.TransmissionStyle,r.BodyClass].filter(Boolean).join(" · ");
  var codes=String(r.ErrorCode||"").split(/[,\s]+/).filter(Boolean);
  return {year:year,make:make,model:model,trim:r.Trim||"",specs:specs,
    title:[year,make,model,r.Trim].filter(Boolean).join(" "),
    partial:codes.some(function(c){return c!=="0"})};
}
/* Turn an NHTSA recallsByVehicle answer into a short list. */
function parseRecalls(json){
  var list=(json&&(json.results||json.Results))||[];
  return {count:list.length,items:list.slice(0,20).map(function(x){return {id:x.NHTSACampaignNumber||"",component:x.Component||"",date:x.ReportReceivedDate||""}})}}
function vpicUrl(vin){return "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/"+encodeURIComponent(cleanVin(vin))+"?format=json"}
function recallsUrl(make,model,year){return "https://api.nhtsa.gov/recalls/recallsByVehicle?make="+encodeURIComponent(make)+"&model="+encodeURIComponent(model)+"&modelYear="+encodeURIComponent(year)}
function vinRecallPage(vin){return "https://www.nhtsa.gov/recalls?vin="+encodeURIComponent(cleanVin(vin))}

/* ---------- backup ---------- */
var BACKUP_APP="driveway-finds";
function makeBackup(state,now){return {app:BACKUP_APP,version:1,exportedAt:new Date(now||Date.now()).toISOString(),
  searches:state.searches||[],finds:state.finds||[],settings:state.settings||{}}}
/* Checks a backup file and keeps only well-formed rows. Throws a plain-language error when it is not a backup. */
function readBackup(text){
  var j;try{j=JSON.parse(text)}catch(e){throw new Error("That file is not a Driveway Finds backup.")}
  if(!j||j.app!==BACKUP_APP||!Array.isArray(j.searches)||!Array.isArray(j.finds))throw new Error("That file is not a Driveway Finds backup.");
  var okId=function(x){return x&&typeof x==="object"&&typeof x.id==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(x.id)};
  return {searches:j.searches.filter(okId),finds:j.finds.filter(function(f){return okId(f)&&safeUrl(f.url)}),
    settings:j.settings&&typeof j.settings==="object"?j.settings:{}}}
/* Adds backup rows that are not already here. Matches searches by id or identical filters, finds by id or link. */
function mergePlan(state,backup){
  var have={};state.searches.forEach(function(s){have[s.id]=1});
  var searches=backup.searches.filter(function(s){return !have[s.id]&&!state.searches.some(function(x){return sameCriteria(x.criteria,s.criteria)})});
  var haveF={};state.finds.forEach(function(f){haveF[f.id]=1});
  var seenUrl={};state.finds.forEach(function(f){var k=normUrl(f.url);if(k)seenUrl[k]=1});
  var finds=backup.finds.filter(function(f){var k=normUrl(f.url);if(haveF[f.id]||seenUrl[k])return false;seenUrl[k]=1;return true});
  return {searches:searches,finds:finds,skipped:(backup.searches.length-searches.length)+(backup.finds.length-finds.length)}}

return {FIELDS:FIELDS,LABELS:LABELS,STAGES:STAGES,money:money,num:num,slug:slug,safeUrl:safeUrl,vtext:vtext,vlist:vlist,splitVehicle:splitVehicle,
  title:title,chipList:chipList,criteriaKey:criteriaKey,sameCriteria:sameCriteria,skippedFilters:skippedFilters,
  fbUrl:fbUrl,fbLinks:fbLinks,atUrl:atUrl,clUrl:clUrl,clSites:clSites,carsUrl:carsUrl,offerupUrl:offerupUrl,
  siteOf:siteOf,guessTitle:guessTitle,detectTitle:detectTitle,normUrl:normUrl,findByUrl:findByUrl,cpm:cpm,budgetGap:budgetGap,
  withPrice:withPrice,priceChange:priceChange,cleanVin:cleanVin,checkVin:checkVin,findVin:findVin,parseVpic:parseVpic,parseRecalls:parseRecalls,
  vpicUrl:vpicUrl,recallsUrl:recallsUrl,vinRecallPage:vinRecallPage,makeBackup:makeBackup,readBackup:readBackup,mergePlan:mergePlan};
});
