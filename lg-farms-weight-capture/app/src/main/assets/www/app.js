/* LG Farms — broiler weight calibration capture.
   Offline. Every bird is written to disk the moment it is saved. */
(function () {
'use strict';

var LONG_EDGE   = 1600;   // saved image long edge, px
var JPEG_Q      = 0.85;
var THUMB_EDGE  = 96;
var MAX_SKEW    = 1.15;   // longest marker side / shortest, above which we warn

var bridge = window.LGFarms || null;
var detector = null;

var S = {                 // live session
  id:null, house:'', batch:'', age:null, date:'', boardId:0, markerMm:150,
  birds:[]
};
var pending = null;       // { blob, dataUrl, thumb, geom, w, h }
var typed = '';
var stream = null, rafId = 0, busy = false;

// ------------------------------------------------------------- utilities
function $(s){ return document.querySelector(s); }
function show(id){
  var els = document.querySelectorAll('.screen');
  for (var i=0;i<els.length;i++) els[i].classList.remove('active');
  $(id).classList.add('active');
}
function toast(m){
  var t=$('#toast'); t.textContent=m; t.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(function(){t.classList.remove('show');},2200);
}
function pad(n,w){ n=String(n); while(n.length<w) n='0'+n; return n; }
function today(){
  var d=new Date();
  return d.getFullYear()+'-'+pad(d.getMonth()+1,2)+'-'+pad(d.getDate(),2);
}
function save(){ try{ localStorage.setItem('lgf.session', JSON.stringify(S)); }catch(e){} }
function load(){
  try{ var r=localStorage.getItem('lgf.session'); return r?JSON.parse(r):null; }catch(e){ return null; }
}
function slug(s){ return String(s||'').replace(/[^A-Za-z0-9._-]/g,'-').slice(0,24) || 'x'; }
function folder(){ return 'weights/' + S.date + '_h' + slug(S.house) + '_d' + S.age; }

// -------------------------------------------------------------- geometry
/* Marker corners -> scale and a squareness check.
   mm_per_px is the scale at the board surface, and because the marker's
   apparent size falls off with camera distance it also stands in for how
   high the phone was held. Both go in the CSV. */
function geometry(marker){
  if (!marker) return { ok:false, id:-1, px:0, mmpp:0, skew:0 };
  var c = marker.corners, side = [];
  for (var i=0;i<4;i++){
    var a=c[i], b=c[(i+1)%4];
    side.push(Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.y-b.y)*(a.y-b.y)));
  }
  var mx=Math.max.apply(null,side), mn=Math.min.apply(null,side);
  var mean=(side[0]+side[1]+side[2]+side[3])/4;
  return {
    ok:true, id:marker.id, px:mean,
    mmpp: mean>0 ? S.markerMm/mean : 0,
    skew: mn>0 ? mx/mn : 99,
    corners:c
  };
}
function verdict(g){
  if (!g.ok) return { cls:'bad', msg:'No marker — move so the whole square is in frame' };
  if (S.boardId >= 0 && g.id !== S.boardId)
    return { cls:'bad', msg:'Wrong board (found id '+g.id+')' };
  if (g.skew > MAX_SKEW)
    return { cls:'mid', msg:'Tilted — hold the phone flat above the board' };
  return { cls:'good', msg:'Marker locked · '+g.mmpp.toFixed(3)+' mm/px' };
}

// ---------------------------------------------------------------- camera
function startCam(){
  if (stream) return Promise.resolve();
  return navigator.mediaDevices.getUserMedia({
    audio:false,
    video:{ facingMode:{ideal:'environment'},
            width:{ideal:2560}, height:{ideal:1440} }
  }).then(function(st){
    stream = st;
    var v = $('#video');
    v.srcObject = st;
    return v.play();
  }).then(function(){
    if (bridge && bridge.keepAwake) bridge.keepAwake(true);
    loop();
  });
}
function stopCam(){
  cancelAnimationFrame(rafId); rafId=0;
  if (stream){ stream.getTracks().forEach(function(t){t.stop();}); stream=null; }
  if (bridge && bridge.keepAwake) bridge.keepAwake(false);
}

/* ---------------------------------------------------- multi-scale detect

   A broiler house at 10 lux forces the phone's gain up, and the resulting
   sensor noise breaks marker detection at full resolution. Downscaling
   averages that noise away, so we retry at progressively smaller sizes
   (with a light blur) until the marker is found, then map the corners back
   to full-image pixels. Bench-tested: full res fails where half res and a
   3x3 blur still succeed. The scale that worked is recorded per bird. */
var sc2 = document.createElement('canvas');
var s2x = sc2.getContext('2d', {willReadFrequently:true});
var SCALES = [1, 0.5, 0.375, 0.25];

function pick(ms){
  if (!ms || !ms.length) return null;
  for (var i=0;i<ms.length;i++) if (S.boardId < 0 || ms[i].id === S.boardId) return ms[i];
  return ms[0];                                     // wrong board: report it, don't hide it
}

function detectAt(src, scale, blurPx){
  var w = Math.max(120, Math.round(src.width*scale));
  var h = Math.max(90,  Math.round(src.height*scale));
  sc2.width=w; sc2.height=h;
  s2x.imageSmoothingEnabled = true;
  s2x.imageSmoothingQuality = 'high';
  s2x.filter = blurPx ? 'blur('+blurPx+'px)' : 'none';
  s2x.clearRect(0,0,w,h);
  s2x.drawImage(src, 0, 0, w, h);
  s2x.filter = 'none';
  try { return { m:pick(detector.detect(s2x.getImageData(0,0,w,h))), k:w/src.width }; }
  catch(e){ return { m:null, k:1 }; }
}

/* Returns corners in SOURCE pixel coordinates, or null. */
function detectBest(src, quick){
  var list = quick ? [[0.5,0.8]] : [[1,0],[1,0.8],[0.5,0],[0.5,0.8],[0.375,0.8],[0.25,0.8]];
  for (var i=0;i<list.length;i++){
    var r = detectAt(src, list[i][0], list[i][1]);
    if (r.m){
      var cs=[];
      for (var j=0;j<4;j++) cs.push({ x:r.m.corners[j].x/r.k, y:r.m.corners[j].y/r.k });
      return { id:r.m.id, corners:cs, scale:list[i][0], blur:list[i][1] };
    }
  }
  return null;
}

/* Live preview: one cheap pass only, so the viewfinder stays smooth. */
var pc = document.createElement('canvas'), pctx = pc.getContext('2d');
function loop(){
  rafId = requestAnimationFrame(loop);
  var v = $('#video');
  if (!v.videoWidth || busy) return;
  if (loop._n === undefined) loop._n = 0;
  if (++loop._n % 5) return;

  var sc = Math.min(1, 900 / v.videoWidth);
  pc.width = Math.round(v.videoWidth*sc); pc.height = Math.round(v.videoHeight*sc);
  pctx.drawImage(v, 0, 0, pc.width, pc.height);

  var f = detectBest(pc, true);
  if (f) for (var i=0;i<4;i++){ f.corners[i].x/=sc; f.corners[i].y/=sc; }

  var g = geometry(f);
  var vd = verdict(g);
  var chip = $('#chip');
  chip.textContent = vd.msg;
  chip.className = 'chip ' + vd.cls;
  draw(f);
}

function draw(found){
  var v=$('#video'), cv=$('#overlay');
  var W=cv.clientWidth, H=cv.clientHeight;
  if (cv.width!==W || cv.height!==H){ cv.width=W; cv.height=H; }
  var ctx=cv.getContext('2d');
  ctx.clearRect(0,0,W,H);
  if (!found) return;
  var k = Math.max(W/v.videoWidth, H/v.videoHeight);   // undo object-fit:cover
  var ox = (W - v.videoWidth*k)/2, oy = (H - v.videoHeight*k)/2;
  ctx.strokeStyle='#3ea36b'; ctx.lineWidth=3; ctx.beginPath();
  for (var i=0;i<4;i++){
    var p=found.corners[i];
    var x=ox+p.x*k, y=oy+p.y*k;
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  }
  ctx.closePath(); ctx.stroke();
}

// --------------------------------------------------------------- capture
function shoot(){
  var v=$('#video');
  if (!v.videoWidth || busy) return;
  busy = true;
  $('#btn-shoot').disabled = true;

  var k = LONG_EDGE / Math.max(v.videoWidth, v.videoHeight);
  if (k > 1) k = 1;                                  // never upscale
  var w = Math.round(v.videoWidth*k), h = Math.round(v.videoHeight*k);

  var c = document.createElement('canvas');
  c.width=w; c.height=h;
  var cx = c.getContext('2d');
  cx.drawImage(v, 0, 0, w, h);

  // Measure on exactly the image that gets written, so the CSV geometry
  // matches the file the PC will later process. Full cascade here: a couple
  // of extra hundred milliseconds is cheap next to losing the bird.
  var found = detectBest(c, false);

  var g = geometry(found);
  var dataUrl = c.toDataURL('image/jpeg', JPEG_Q);

  var tc=document.createElement('canvas');
  var tk = THUMB_EDGE/Math.max(w,h);
  tc.width=Math.round(w*tk); tc.height=Math.round(h*tk);
  tc.getContext('2d').drawImage(c,0,0,tc.width,tc.height);

  pending = { dataUrl:dataUrl, thumb:tc.toDataURL('image/jpeg',0.5),
              geom:g, w:w, h:h, det:found?found.scale:0,
              at:new Date().toISOString() };

  typed=''; $('#w-val').textContent='0';
  $('#shot').src = dataUrl;
  var vd = verdict(g);
  var st = $('#shot-status');
  st.textContent = vd.msg; st.className='chip inline '+vd.cls;

  stopCam();
  show('#scr-weight');
  busy=false; $('#btn-shoot').disabled=false;
}

// ------------------------------------------------------------ save a bird
function saveBird(){
  var grams = parseInt(typed,10);
  if (!grams || grams<20 || grams>9000){ toast('Enter a weight between 20 and 9000 g'); return; }
  if (!pending) return;

  var seq = S.birds.length+1;
  var name = 'h'+slug(S.house)+'_d'+S.age+'_'+S.date+'_'+pad(seq,4)+'_'+grams+'g.jpg';

  var written = '';
  if (bridge && bridge.saveImage){
    written = bridge.saveImage(pending.dataUrl, folder(), name) || '';
    if (!written){ toast('Could not write the image — nothing saved'); return; }
  } else {
    // Browser mode: push each image straight to the Downloads folder.
    // Chrome asks once to allow multiple downloads, then stops asking.
    try {
      var a=document.createElement('a');
      a.href=pending.dataUrl; a.download=name;
      document.body.appendChild(a); a.click(); a.remove();
      written='(downloads)';
    } catch(e){ toast('Could not download the image'); return; }
  }

  S.birds.push({
    seq:seq, g:grams, file:name, path:written,
    ok:pending.geom.ok?1:0, mid:pending.geom.id,
    px:+pending.geom.px.toFixed(2), mmpp:+pending.geom.mmpp.toFixed(5),
    skew:+pending.geom.skew.toFixed(3),
    w:pending.w, h:pending.h, det:pending.det, at:pending.at, thumb:pending.thumb
  });
  save();
  pending=null; typed='';
  $('#cap-count').textContent = S.birds.length;
  toast('Bird '+seq+' saved — '+grams+' g');
  show('#scr-capture');
  startCam().catch(camFail);
}

// ----------------------------------------------------------------- review
function renderReview(){
  var n=S.birds.length;
  var st=$('#stats');
  if (!n){ st.innerHTML='<strong>No birds yet</strong>'; }
  else{
    var g=S.birds.map(function(b){return b.g;});
    var sum=g.reduce(function(a,b){return a+b;},0), mean=sum/n;
    var sd=Math.sqrt(g.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/Math.max(1,n-1));
    var bad=S.birds.filter(function(b){return !b.ok||b.skew>MAX_SKEW;}).length;
    st.innerHTML =
      '<strong>'+n+' birds · mean '+mean.toFixed(0)+' g</strong>'+
      '<p class="dim small">CV '+(100*sd/mean).toFixed(1)+'% · range '+
      Math.min.apply(null,g)+'–'+Math.max.apply(null,g)+' g'+
      (bad? ' · <span style="color:var(--warn)">'+bad+' with marker problems</span>':'')+'</p>';
  }
  var html='';
  for (var i=S.birds.length-1;i>=0;i--){
    var b=S.birds[i];
    var flag = !b.ok ? 'no marker' : (b.skew>MAX_SKEW ? 'tilted' : 'ok');
    html += '<div class="item"><img src="'+b.thumb+'" alt="">'+
            '<div class="meta">#'+b.seq+' · '+flag+
            (b.ok?' · '+b.mmpp.toFixed(3)+' mm/px':'')+'<br>'+b.file+'</div>'+
            '<div class="g">'+b.g+'</div>'+
            '<button class="del" data-i="'+i+'">&#10005;</button></div>';
  }
  $('#list').innerHTML = html;
}

/* The image files stay on disk when a row is removed — deliberately.
   Deleting shared-storage files needs extra permission, and an orphan
   image is harmless as long as the CSV is the source of truth. */
function removeBird(i){
  S.birds.splice(i,1);
  for (var k=0;k<S.birds.length;k++) S.birds[k].seq=k+1;
  save(); renderReview();
}

// ------------------------------------------------------------------- CSV
function csv(){
  var head = ['session_id','house','batch','age_days','date','board_id','marker_mm',
              'seq','weight_g','filename','marker_found','marker_id','marker_px',
              'mm_per_px','skew','img_w','img_h','det_scale','captured_at'];
  var rows = [head.join(',')];
  S.birds.forEach(function(b){
    rows.push([S.id,S.house,S.batch,S.age,S.date,S.boardId,S.markerMm,
               b.seq,b.g,b.file,b.ok,b.mid,b.px,b.mmpp,b.skew,b.w,b.h,b.det,b.at]
              .map(function(x){
                x=String(x==null?'':x);
                return /[",\n]/.test(x) ? '"'+x.replace(/"/g,'""')+'"' : x;
              }).join(','));
  });
  return rows.join('\n')+'\n';
}

function finish(){
  if (!S.birds.length){ toast('Nothing to write yet'); return; }
  var name = S.date+'_h'+slug(S.house)+'_d'+S.age+'_weights.csv';
  var path = '';
  if (bridge && bridge.saveText){
    path = bridge.saveText(csv(), folder(), name, 'text/csv') || '';
    if (!path){ toast('Could not write the CSV'); return; }
  } else {
    var a=document.createElement('a');
    a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv());
    a.download=name; a.click();
    path='(downloaded)';
  }
  try{
    var idx=JSON.parse(localStorage.getItem('lgf.index')||'[]');
    idx.push({id:S.id,date:S.date,house:S.house,age:S.age,n:S.birds.length,csv:name});
    localStorage.setItem('lgf.index', JSON.stringify(idx));
  }catch(e){}

  $('#done-detail').innerHTML =
    '<strong>'+S.birds.length+' birds written</strong>'+
    '<p class="dim small">Images and CSV are in<br><code>Downloads/'+
    'LG Farms/'+folder()+'/</code></p>';
  localStorage.removeItem('lgf.session');
  stopCam();
  show('#scr-done');
}

// ------------------------------------------------------------------ wiring
function camFail(e){
  $('#chip').className='chip bad';
  $('#chip').textContent='Camera unavailable — check the permission';
  toast('Camera error: '+(e && e.name ? e.name : e));
}

function startSession(){
  var house=$('#f-house').value.trim(), age=$('#f-age').value.trim();
  var mm=parseFloat($('#f-mm').value);
  if (!house){ toast('Enter the house'); return; }
  if (age===''){ toast('Enter the age in days'); return; }
  if (!(mm>50 && mm<400)){ toast('Marker size looks wrong'); return; }

  S = { id:'s'+Date.now(), house:house, batch:$('#f-batch').value.trim(),
        age:parseInt(age,10), date:$('#f-date').value||today(),
        boardId:parseInt($('#f-board').value,10), markerMm:mm, birds:[] };
  save();
  $('#cap-count').textContent='0';
  $('#cap-info').textContent='House '+S.house+' · day '+S.age;
  show('#scr-capture');
  startCam().catch(camFail);
}

function boot(){
  try{
    detector = new AR.Detector({ dictionaryName:'ARUCO_4X4_50', maxHammingDistance:1 });
  }catch(e){
    detector = { detect:function(){ return []; } };
    toast('Marker detector failed to load');
  }

  $('#f-date').value = today();
  if (bridge && bridge.version) $('#ver').textContent = 'v'+bridge.version();
  $('#storage-note').textContent = bridge
    ? 'Images are written to Downloads/LG Farms/ on this phone.'
    : 'Running without the native shell — files will download instead.';

  var prev = load();
  if (prev && prev.birds && prev.birds.length){
    $('#resume').classList.remove('hidden');
    $('#resume-detail').textContent =
      prev.birds.length+' birds · house '+prev.house+' · day '+prev.age+' · '+prev.date;
    $('#btn-resume').onclick = function(){
      S = prev;
      $('#cap-count').textContent = S.birds.length;
      $('#cap-info').textContent = 'House '+S.house+' · day '+S.age;
      show('#scr-capture'); startCam().catch(camFail);
    };
    $('#btn-discard').onclick = function(){
      if (confirm('Discard '+prev.birds.length+' unsaved birds? Images already on disk are kept.')){
        localStorage.removeItem('lgf.session');
        $('#resume').classList.add('hidden');
      }
    };
  }

  $('#btn-start').onclick  = startSession;
  $('#btn-shoot').onclick  = shoot;
  $('#btn-review').onclick = function(){ stopCam(); renderReview(); show('#scr-review'); };
  $('#btn-more').onclick   = function(){ show('#scr-capture'); startCam().catch(camFail); };
  $('#btn-finish').onclick = finish;
  $('#btn-retake').onclick = function(){ pending=null; show('#scr-capture'); startCam().catch(camFail); };
  $('#btn-save').onclick   = saveBird;
  $('#btn-new').onclick    = function(){ location.reload(); };
  $('#btn-past').onclick   = function(){
    var idx=[];
    try{ idx=JSON.parse(localStorage.getItem('lgf.index')||'[]'); }catch(e){}
    toast(idx.length ? idx.length+' sessions written from this phone' : 'No sessions written yet');
  };
  $('#btn-back-cap').onclick = function(){ stopCam(); renderReview(); show('#scr-review'); };
  $('#btn-back-rev').onclick = function(){ show('#scr-capture'); startCam().catch(camFail); };

  document.querySelector('.keys').addEventListener('click', function(e){
    var b=e.target.closest('button'); if(!b) return;
    var k=b.dataset.k;
    if (k==='clr') typed='';
    else if (k==='del') typed=typed.slice(0,-1);
    else if (typed.length<5) typed=(typed+b.textContent.trim()).replace(/^0+/,'');
    $('#w-val').textContent = typed||'0';
  });

  $('#list').addEventListener('click', function(e){
    var b=e.target.closest('.del'); if(!b) return;
    if (confirm('Remove bird #'+(+b.dataset.i+1)+' from the CSV?')) removeBird(+b.dataset.i);
  });

  window.__androidBack = function(){
    if ($('#scr-weight').classList.contains('active')){
      pending=null; show('#scr-capture'); startCam().catch(camFail); return true;
    }
    if ($('#scr-capture').classList.contains('active')){
      stopCam(); renderReview(); show('#scr-review'); return true;
    }
    if ($('#scr-review').classList.contains('active')){
      show('#scr-capture'); startCam().catch(camFail); return true;
    }
    return false;
  };
  window.__permsChanged = function(){
    if ($('#scr-capture').classList.contains('active')) startCam().catch(camFail);
  };

  document.addEventListener('visibilitychange', function(){
    if (document.hidden) stopCam();
    else if ($('#scr-capture').classList.contains('active')) startCam().catch(camFail);
  });
}

document.addEventListener('DOMContentLoaded', boot);
})();
