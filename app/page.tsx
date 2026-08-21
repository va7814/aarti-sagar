'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, CircleUserRound, Clock3, FileImage, Home, Mic, Plus, Search, ShieldCheck, Upload, X } from 'lucide-react';
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

type Aarti = { title: string; deity: string; category: string; source: string; text: string; lines: number };
type Request = { id?: string; title: string; deity: string; text?: string; source?: string; submitted: string; status: 'In review' | 'Approved' };
type DraftAarti = { title: string; deity: string; text: string; source: string };
const pythonApiUrl = process.env.NEXT_PUBLIC_PYTHON_API_URL || 'http://127.0.0.1:8000';
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: (event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void;
  onerror: () => void;
  onend: () => void;
};

const aartis: Aarti[] = [
  { title: 'सुखकर्ता दुःखहर्ता', deity: 'श्री गणपती', category: 'गणपती', source: 'परंपरागत', text: 'सुखकर्ता दुःखहर्ता वार्ता विघ्नाची।\nनुरवी पुरवी प्रेम कृपा जयाची॥\nसर्वांगी सुंदर उटी शेंदुराची।\nकंठी झळके माळ मुक्ताफळांची॥', lines: 4 },
  { title: 'दुर्गे दुर्घट भारी', deity: 'श्री दुर्गा देवी', category: 'देवी', source: 'श्री समर्थ रामदास', text: 'दुर्गे दुर्घट भारी तुजविण संसारी।\nअनाथनाथे अंबे करुणा विस्तारी॥\nवारी वारी जन्म मरणाते वारी।\nहारी पडलो आता संकट निवारी॥', lines: 4 },
  { title: 'युगायुगाचा नाथ', deity: 'श्री विठ्ठल', category: 'विठ्ठल', source: 'परंपरागत', text: 'युगायुगाचा नाथ विठ्ठल माझा।\nचरणी ठेविले माथा, हाचि ध्यास माझा॥', lines: 2 },
  { title: 'लवथवती विक्राळा', deity: 'श्री शंकर', category: 'शंकर', source: 'संत एकनाथ', text: 'लवथवती विक्राळा ब्रह्मांडी माळा।\nवीषे कंठ काळा त्रिनेत्री ज्वाळा॥', lines: 2 },
  { title: 'घालीन लोटांगण', deity: 'श्री गणपती', category: 'गणपती', source: 'परंपरागत', text: 'घालीन लोटांगण वंदीन चरण।\nडोळ्यांनी पाहिन रूप तुझे॥', lines: 2 },
];
const initialRequests: Request[] = [];

export default function HomePage() {
  const [active, setActive] = useState('library');
  const [query, setQuery] = useState('');
  const [listening, setListening] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [requests, setRequests] = useState(initialRequests);
  const [fileName, setFileName] = useState('');
  const [selectedDeity, setSelectedDeity] = useState('श्री गणपती');
  const [draftAartis, setDraftAartis] = useState<DraftAarti[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [adminMode, setAdminMode] = useState(false);
  const [selectedAarti, setSelectedAarti] = useState<Aarti | null>(null);
  const [voiceError, setVoiceError] = useState('');
  const [extractionError, setExtractionError] = useState('');
  const [aiResults, setAiResults] = useState<Aarti[] | null>(null);
  const [deityOptions, setDeityOptions] = useState<string[]>([]);
  const [advertisements, setAdvertisements] = useState({ left: [] as string[], right: [] as string[] });
  const speechRecognition = useRef<SpeechRecognitionLike | null>(null);
  const [catalog, setCatalog] = useState(aartis);
  const deities = deityOptions.length ? deityOptions : Array.from(new Set(catalog.map((aarti) => aarti.deity)));
  const filtered = useMemo(() => aiResults || catalog.filter((aarti) => `${aarti.title} ${aarti.deity} ${aarti.category}`.toLowerCase().includes(query.toLowerCase())), [aiResults, catalog, query]);

  useEffect(() => {
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) { setRole('user'); setAdminMode(false); setActive('library'); return; }
      const tokenResult = await nextUser.getIdTokenResult();
      let profileRole = 'user';
      try {
        const profile = await getDoc(doc(db, 'users', nextUser.uid));
        profileRole = profile.data()?.role || 'user';
      } catch {
        // A custom admin claim remains a valid source of authority if the profile read is unavailable.
      }
      const nextRole = tokenResult.claims.admin === true || profileRole === 'admin' ? 'admin' : 'user';
      setRole(nextRole);
      setAdminMode(nextRole === 'admin');
      setActive(nextRole === 'admin' ? 'admin' : 'library');
    });
  }, []);

  useEffect(() => {
    void fetch('/advertisements/ads.json').then((response) => response.ok ? response.json() : { left: [], right: [] }).then((result) => setAdvertisements(result as { left: string[]; right: string[] })).catch(() => undefined);
  }, []);

  useEffect(() => {
    void Promise.all([
      fetch(`${pythonApiUrl}/catalog`).then((response) => response.ok ? response.json() : []),
      user ? user.getIdToken().then((token) => fetch(`${pythonApiUrl}/submissions`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() : [])) : Promise.resolve([]),
      fetch(`${pythonApiUrl}/deities`).then((response) => response.ok ? response.json() : []),
    ]).then(([catalogResults, submissionResults, deityResults]) => {
      setCatalog((catalogResults as Array<{ title: string; deity: string; source?: string; text: string }>).map((result) => ({ title: result.title, deity: result.deity, category: result.deity.replace('श्री ', ''), source: result.source || 'Catalog', text: result.text, lines: result.text.split('\n').length })));
      setRequests((submissionResults as Array<Omit<Request, 'submitted'>>).map((submission) => ({ ...submission, submitted: 'Submitted' })));
      setDeityOptions(deityResults as string[]);
    }).catch(() => undefined);
  }, [user, role]);

  const showLocalResults = (searchQuery: string) => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase('mr-IN');
    setAiResults(normalizedQuery ? catalog.filter((aarti) => `${aarti.title} ${aarti.deity} ${aarti.category}`.toLocaleLowerCase('mr-IN').includes(normalizedQuery)) : null);
  };

  const runSearch = async (searchQuery = query) => {
    if (!searchQuery.trim()) { setAiResults(null); return; }
    try {
      const response = await fetch(`${pythonApiUrl}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: searchQuery }) });
      if (!response.ok) return;
      const results = await response.json() as Array<{ title: string; deity: string; source?: string; text: string }>;
      setAiResults(results.map((result) => ({ title: result.title, deity: result.deity, category: result.deity.replace('श्री ', ''), source: result.source || 'Catalog', text: result.text, lines: result.text.split('\n').length })));
    } catch { /* Local search remains available when Python is offline. */ }
  };

  const startVoice = () => {
    setVoiceError('');
    const Recognition = (window as Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition
      || (window as Window & { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;
    if (Recognition) {
      const recognition = new Recognition();
      speechRecognition.current = recognition;
      recognition.lang = 'mr-IN';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        const transcript = Array.from(event.results).map((result) => result[0].transcript).join('');
        setQuery(transcript);
        showLocalResults(transcript);
      };
      recognition.onerror = () => { setListening(false); setVoiceError('Voice recognition failed. Please try again.'); };
      recognition.onend = () => { setListening(false); speechRecognition.current = null; };
      setListening(true);
      recognition.start();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { setQuery('सुखकर्ता दुःखहर्ता'); void runSearch('सुखकर्ता दुःखहर्ता'); return; }
    void navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const formData = new FormData(); formData.append('audio', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), 'voice-search.webm');
        try {
          const response = await fetch(`${pythonApiUrl}/voice-to-text`, { method: 'POST', body: formData });
          const body = await response.text();
          let result: { text?: string; detail?: string } = {};
          try { result = body ? JSON.parse(body) as { text?: string; detail?: string } : {}; } catch { result = { detail: 'Voice service returned an invalid response.' }; }
          if (!response.ok) { setVoiceError(result.detail || 'Voice search failed.'); return; }
          if (result.text) { setQuery(result.text); showLocalResults(result.text); }
          else setVoiceError('No speech was detected. Please try again.');
        } catch {
          setVoiceError('Voice service is unavailable. Start the Python backend and try again.');
        } finally { setListening(false); }
      };
      setListening(true); recorder.start(); window.setTimeout(() => recorder.stop(), 2200);
    }).catch(() => setListening(false));
  };
  const extractAartis = async (file: File) => {
    setFileName(file.name); setDraftAartis([]); setExtractionError(''); setExtracting(true);
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const formData = new FormData(); formData.append(isPdf ? 'document' : 'image', file); formData.append('deity', selectedDeity);
    try {
      const token = user ? await user.getIdToken() : '';
      const response = await fetch(`${pythonApiUrl}/${isPdf ? 'extract-aarti-pdf' : 'extract-aarti'}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData });
      const responseBody = await response.text();
      if (!response.ok) {
        let detail = 'Image extraction failed.';
        try { detail = (JSON.parse(responseBody) as { detail?: string }).detail || detail; } catch { /* Keep the readable fallback. */ }
        throw new Error(detail);
      }
      const extracted = JSON.parse(responseBody) as DraftAarti | DraftAarti[];
      setDraftAartis(Array.isArray(extracted) ? extracted : [extracted]);
    } catch (error) { setExtractionError(error instanceof Error ? error.message : 'Could not convert this image to text.'); }
    finally { setExtracting(false); }
  };
  const updateDraftAarti = (index: number, update: Partial<DraftAarti>) => {
    setDraftAartis((currentDrafts) => currentDrafts.map((draft, draftIndex) => draftIndex === index ? { ...draft, ...update } : draft));
  };
  const submitRequests = async () => {
    if (!draftAartis.length || !user) return;
    const token = await user.getIdToken();
    const responses = await Promise.all(draftAartis.map((draft) => fetch(`${pythonApiUrl}/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(draft) })));
    if (responses.some((response) => !response.ok)) { setExtractionError('Some aartis could not be submitted. Please try again.'); return; }
    const submissions = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string; title: string; deity: string; text: string; source: string; status: 'In review' | 'Approved' }>));
    setRequests((currentRequests) => [...submissions.map((submission) => ({ ...submission, submitted: 'Just now' })), ...currentRequests]); setFileName(''); setDraftAartis([]); setShowUpload(false); setActive('requests');
  };
  const authenticate = async () => {
    setAuthError('');
    try {
      if (authMode === 'signup') {
        const credential = await createUserWithEmailAndPassword(auth, authEmail, authPassword);
        await setDoc(doc(db, 'users', credential.user.uid), { displayName: credential.user.email, role: 'user' });
      } else await signInWithEmailAndPassword(auth, authEmail, authPassword);
      setShowAuth(false); setAuthEmail(''); setAuthPassword('');
    } catch { setAuthError('Authentication failed. Check your email and password.'); }
  };
  const approveRequest = async (request: Request) => {
    if (!request.id || role !== 'admin' || !user) return;
    const token = await user.getIdToken();
    const response = await fetch(`${pythonApiUrl}/submissions/${request.id}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return;
    const approved = await response.json() as { title: string; deity: string; text: string; source: string; status: 'Approved' };
    setRequests((currentRequests) => currentRequests.map((item) => item.id === request.id ? { ...item, status: 'Approved' } : item));
    setCatalog((currentCatalog) => [...currentCatalog, { title: approved.title, deity: approved.deity, category: approved.deity.replace('श्री ', ''), source: approved.source, text: approved.text, lines: approved.text.split('\n').length }]);
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#"><span className="brand-mark">ॐ</span><span className="brand-name">Aarati Sagar</span></a>
      <div className="nav-label">LIBRARY</div>
      <nav className="nav">
        <button className={active === 'library' ? 'active' : ''} onClick={() => setActive('library')}><Home size={16} /> Aarti library</button>
        <button className={active === 'requests' ? 'active' : ''} onClick={() => setActive('requests')}><Clock3 size={16} /> My requests</button>
        {adminMode && <button className={active === 'admin' ? 'active' : ''} onClick={() => setActive('admin')}><ShieldCheck size={16} /> Admin review</button>}
      </nav>
      <div className="side-ad-list">{advertisements.left.map((advertisement) => <Advertisement key={advertisement} name={advertisement} />)}</div>
      <div className="side-bottom"><strong>Preserve a prayer</strong>Upload a handwritten or printed aarti for the next generation.</div>
    </aside>
    <main className="main">
      <header className="topbar"><button className="admin-link" onClick={() => { if (role === 'admin') { setAdminMode(!adminMode); setActive(adminMode ? 'library' : 'admin'); } else setShowAuth(true); }}> {role === 'admin' && adminMode ? 'Exit admin view' : role === 'admin' ? 'Admin review' : 'Sign in'} </button><button className="submit" onClick={() => user ? setShowUpload(true) : setShowAuth(true)}><Plus size={14} /> Contribute to aarti sagar</button><div className="user-pill"><span className="avatar">{user ? 'U' : 'G'}</span> {user ? user.email : 'Guest'} {user && <button className="sign-out" onClick={() => void signOut(auth)}>Sign out</button>} {!user && <CircleUserRound size={14} color="#aaa095" />}</div></header>
      <div className="content">
        {active === 'admin' && role === 'admin' ? <AdminView requests={requests} onApprove={approveRequest} /> : active === 'requests' ? <RequestsView requests={requests} /> : <>
          <p className="subtitle">Search, read, and preserve Marathi aartis in one living library.</p>
          <div className="search-wrap"><div className="search-box"><Search size={18} color="#aaa095" /><input value={query} onChange={(e) => { setQuery(e.target.value); setAiResults(null); }} onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }} placeholder="Search by aarti or deity..." /><button aria-label="Search by voice" className={`voice-btn ${listening ? 'listening' : ''}`} onClick={startVoice}><Mic size={17} /></button><button className="search-btn" onClick={() => void runSearch()}>Search</button></div><div className="quick-row">Popular <button onClick={() => { setQuery('गणपती'); void runSearch('गणपती'); }}>Ganapati</button><button onClick={() => { setQuery('देवी'); void runSearch('देवी'); }}>Devi</button><button onClick={() => { setQuery('विठ्ठल'); void runSearch('विठ्ठल'); }}>Vitthal</button>{voiceError && <span className="voice-error">{voiceError}</span>}</div></div>
          <div className="library-grid"><section><div className="section-heading"><h2>{query ? 'Search results' : 'Recently added'}</h2><span className="count">{filtered.length} aartis</span></div><div className="aarti-list">{filtered.length ? filtered.map((aarti) => <AartiCard key={aarti.title} aarti={aarti} onRead={setSelectedAarti} />) : <div className="empty">No aarti found for this search.</div>}</div></section><aside className="right-rail"><div className="ad-list">{advertisements.right.map((advertisement) => <Advertisement key={advertisement} name={advertisement} />)}</div></aside></div>
        </>}
      </div>
    </main>
    {selectedAarti && <div className="modal-backdrop"><div className="modal reader-modal"><div className="modal-top"><div><h2>Read aarti</h2><p className="modal-sub"><span className="devanagari">{selectedAarti.deity}</span> · {selectedAarti.source}</p></div><button className="close" onClick={() => setSelectedAarti(null)} aria-label="Close reader"><X size={18} /></button></div><div className="reader-text devanagari">{selectedAarti.text}</div><div className="submit-row"><button className="cancel" onClick={() => setSelectedAarti(null)}>Close</button></div></div></div>}
    {showAuth && <div className="modal-backdrop"><div className="modal"><div className="modal-top"><div><h2>{authMode === 'login' ? 'Sign in' : 'Create account'}</h2><p className="modal-sub">Use an account to contribute aarti scans and track submissions.</p></div><button className="close" onClick={() => setShowAuth(false)} aria-label="Close"><X size={18} /></button></div><div className="review-fields"><label>Email<input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} /></label><label>Password<input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} /></label>{authError && <small className="auth-error">{authError}</small>}</div><div className="submit-row"><button className="cancel" onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}>{authMode === 'login' ? 'Create account' : 'Have an account?'}</button><button className="submit" onClick={() => void authenticate()}>{authMode === 'login' ? 'Sign in' : 'Create account'}</button></div></div></div>}
    {showUpload && <div className="modal-backdrop"><div className="modal contribution-modal"><div className="modal-top"><div><h2>Contribute aartis</h2><p className="modal-sub">Upload an image or PDF, review each extracted aarti, then send the selected items for review.</p></div><button className="close" onClick={() => setShowUpload(false)} aria-label="Close"><X size={18} /></button></div><div className="upload-step"><label className="dropzone"><Upload size={24} /><p>{fileName || 'Drop an image or PDF here, or choose one'}</p><small>JPG, PNG, or PDF · maximum 10 MB · PDF up to 20 pages</small><input className="file-input" type="file" accept="image/*,application/pdf" onChange={(e) => { const file = e.target.files?.[0]; if (file) void extractAartis(file); }} /></label><div className="select-row"><label>Default deity for extraction</label><select value={selectedDeity} onChange={(e) => setSelectedDeity(e.target.value)}>{deities.map((deity) => <option key={deity}>{deity}</option>)}</select></div></div>{extracting && <p className="processing">Converting document to Marathi text...</p>}{extractionError && <p className="auth-error">{extractionError}</p>}{draftAartis.map((draft, index) => <div className="review-fields review-card" key={`${draft.title}-${index}`}><strong>Aarti {index + 1}</strong><label>Title<input value={draft.title} onChange={(e) => updateDraftAarti(index, { title: e.target.value })} /></label><label>Deity<select value={draft.deity} onChange={(e) => updateDraftAarti(index, { deity: e.target.value })}>{deities.map((deity) => <option key={deity}>{deity}</option>)}</select></label><label>Extracted aarti text<textarea className="aarti-textarea devanagari" value={draft.text} onChange={(e) => updateDraftAarti(index, { text: e.target.value })} /></label><small>Source: {draft.source}</small></div>)}<div className="submit-row"><button className="cancel" onClick={() => setShowUpload(false)}>Cancel</button><button className="submit" disabled={!draftAartis.length || extracting || draftAartis.some((draft) => !draft.title.trim() || !draft.deity || !draft.text.trim())} onClick={() => void submitRequests()}>Send {draftAartis.length || ''} for review</button></div></div></div>}
  </div>;
}

function AartiCard({ aarti, onRead }: { aarti: Aarti; onRead: (aarti: Aarti) => void }) { return <article className="aarti-card"><div><h3 className="devanagari">{aarti.title}</h3><div className="meta"><span className="tag devanagari">{aarti.category}</span><span className="devanagari">{aarti.source}</span><span>·</span><span>{aarti.lines} lines</span></div></div><button className="open-btn" onClick={() => onRead(aarti)}><span>Read</span><ChevronRight size={17} /></button></article>; }
function Advertisement({ name }: { name: string }) {
  const [visible, setVisible] = useState(true);
  const [format, setFormat] = useState<'png' | 'jpg'>('png');
  if (!visible) return null;
  return <div className="ad-slot"><img src={`/advertisements/${name}.${format}`} alt="Advertisement" onError={() => format === 'png' ? setFormat('jpg') : setVisible(false)} /></div>;
}
function RequestsView({ requests }: { requests: Request[] }) { return <><div className="eyebrow"><span /> YOUR CONTRIBUTIONS</div><h1>My requests</h1><p className="subtitle">Track the review status of your submitted aartis.</p><section className="requests"><div className="section-heading"><h2>Submitted aartis</h2><span className="count">{requests.length} requests</span></div>{requests.map((request) => <div className="request-row" key={`${request.title}-${request.submitted}`}><div><strong className="devanagari">{request.title}</strong><small className="devanagari">{request.deity} · {request.submitted}</small></div><span className="status">{request.status}</span><FileImage size={16} color="#aaa095" /></div>)}</section></>; }
function AdminView({ requests, onApprove }: { requests: Request[]; onApprove: (request: Request) => void }) { return <><div className="eyebrow"><span /> MODERATION</div><h1>Review submissions</h1><p className="subtitle">Approve new aartis before adding them to the public library.</p><section className="requests"><div className="section-heading"><h2>All submissions</h2><span className="count">{requests.filter((r) => r.status === 'In review').length} pending</span></div>{requests.map((request) => <div className="request-row" key={`${request.id || request.title}-admin`}><div><strong className="devanagari">{request.title}</strong><small className="devanagari">{request.deity} · {request.submitted}</small></div>{request.status === 'In review' ? <button className="status" onClick={() => void onApprove(request)}><Check size={12} /> Approve</button> : <span className="status" style={{ color:'#49735b', background:'#e9f1e7' }}>Approved</span>}<FileImage size={16} color="#aaa095" /></div>)}</section></>; }
