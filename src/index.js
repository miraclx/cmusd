#!/usr/bin/env node
/* eslint no-use-before-define: 0 */
import {existsSync, statSync, createWriteStream, mkdirSync, writeFileSync, unlinkSync, readdirSync} from 'fs';
import {tmpdir as _tmpdir} from 'os';
import {join, dirname} from 'path';
import {format} from 'util';
import {spawnSync, spawn} from 'child_process';
import {underline, green, cyan, red, yellow} from 'chalk';
import Player from 'mpris-service';

const player = Player({
  name: 'cmus',
  identity: 'CMUS Media Player',
  supportedUriSchemes: ['file'],
  supportedMimeTypes: ['audio/mpeg', 'application/ogg', 'audio/x-vorbis+ogg', 'audio/x-flac'],
  supportedInterfaces: ['player'],
});

player.canRaise = false;
player.Fullscreen = false;
player.CanSetFullscreen = false;

const scanners = {
  cmdCut: /\s*\n\s*/g,
  statusParse: /(?:(set|tag)\s(\w+)\s(.+)|(\w+)\s(.+))/,
  artistsParse: /\b\s*(?:&|,|(?:(?:feat(?:uring)?|f[et])\.))\s*/gi,
};

let dataSlice = {cores: {}, tag: {}, set: {}, raw: null};
const tmpdir = join(_tmpdir(), 'cmus-dir');

const stack = {
  state: -1,
  binary: 'cmus-remote',
  cmus_process: null,
  tmp: {
    dir: tmpdir,
    albumart: '',
    lock: join(tmpdir, '.lock'),
    logdir: join(tmpdir, 'logs'),
  },
  logfile: {path: null, stream: null},
  args: {
    next: '-n',
    play: '-p',
    seek: '-k',
    stop: '-s',
    clear: '-c',
    pause: '-u',
    queue: '-q',
    repeat: '-R',
    status: '-Q',
    volume: '-v',
    bitrate: '%{bitrate}',
    shuffle: '-S',
    previous: '-r',
    play_count: '%X',
  },
  events: {
    next: () => pushArg('next'),
    play() {
      pushArg('play');
      log(1, 'playback', 'Media played as per request from remote');
    },
    quit: closeApp,
    seek({delta}) {
      log(2, 'playback', `Seek to ${parsePosition(delta)}`);
      setPosition(delta);
    },
    stop() {
      pushArg('stop');
      log(1, 'playback', 'Music Stopped as per request from remote');
    },
    pause() {
      pushArg('pause');
      log(1, 'playback', 'Media paused as per request from remote');
    },
    volume(volume) {
      volume = (volume * 100 + 0.5) | 0;
      const balancedVolume = getBalancedVolume(true) | 0;
      const parsedVolume = `${volume < balancedVolume ? '-' : '+'}${Math.abs(balancedVolume - volume)}`;
      log(2, 'volume', `Update [L|R]: ${parsedVolume}%`);
      pushArg('volume', `${volume}%`);
      log(1, 'volume', `Current Volume: ${getBalancedVolume(true)}%`);
    },
    position({position}) {
      log(2, 'playback', `Position update to ${parsePosition(position)}`);
      setPosition(position);
    },
    previous: () => pushArg('previous'),
    playpause() {
      pushArg('pause');
      log(1, 'playback', 'Media toggled as per request from remote');
    },
  },
};

function setPosition(position) {
  pushArg('seek', (position / 1000 ** 2) | 0);
  log(1, 'playback', `Updated to ${getPosition(true)}`);
}

function setLogFile(file) {
  if (existsSync(file) && statSync(file).isDirectory()) {
    const time = new Date();
    file = join(
      file,
      `cmus_log_${time.getDate()}-${time.getMonth()}-${time.getFullYear()}_${time.getHours()}-${time.getMinutes()}-${time.getSeconds()}`,
    );
  }
  stack.logfile.path = file;
  stack.logfile.stream = createWriteStream(file);
  log(1, 'logs', `Log file: "${stack.logfile.path}"`);
}

function getThis(data = 'title') {
  return `${dataSlice.tag.artist}${dataSlice.tag[data] ? ` - ${dataSlice.tag[data]}` : ''}`;
}

function getBalancedVolume(host) {
  return ((dataSlice.set.vol_left | 0) + (dataSlice.set.vol_left | 0)) / (host ? 2 : 200);
}

function getPosition(parse) {
  const val = Math.round(dataSlice.cores.position) * 1000 ** 2;
  return !parse ? val : parsePosition(val);
}

function getDuration(parse) {
  const val = Math.round(dataSlice.cores.duration) * 1000 ** 2;
  return !parse ? val : parsePosition(val);
}

function getStatus() {
  updateMetaSlice();
  return `${parseSlice('cores', 'status')
    .slice(0, 1)
    .toUpperCase()}${parseSlice('cores', 'status').slice(1)}`;
}
function getMetadata() {
  return {
    'mpris:length': getDuration(),
    'mpris:artUrl': `file://${dataSlice.cores.art}`,
    'mpris:trackid': player.objectPath(`tracklist/${parseSlice('tag', 'tracknumber')}`),

    'xesam:url': `file://${dataSlice.cores.file}`,
    'xesam:title': parseSlice('tag', 'title'),
    'xesam:album': parseSlice('tag', 'album'),
    'xesam:genre': parseSlice('tag', 'genre'),
    'xesam:artist': parseSlice('tag', 'artist').split(),
    'xesam:albumArtist': parseSlice('tag', 'albumartist').split(scanners.artistsParse),
    'xesam:discNumber': parseSlice('tag', 'discnumber') | 0,
    'xesam:trackNumber': parseSlice('tag', 'tracknumber') | 0,
    'xesam:composer': parseSlice('tag', 'composer').split(scanners.artistsParse),
    'xesam:useCount': parseSlice('tag', 'play_count') | 0,

    ...(parseSlice('tag', 'date') ? {'xesam:contentCreated': new Date(parseSlice('tag', 'date')).toISOString()} : {}),
  };
}

function parseSlice(slot, key) {
  return dataSlice[slot][key] || '';
}

function parsePosition(position) {
  const time = new Date(position / 1000);
  return `${`${time.getMinutes()}`.padStart(2, 0)}:${`${time.getSeconds()}`.padStart(2, 0)}`;
}

function log(actor, action, message) {
  (stack.cmus_process && !stack.cmus_process.killed ? () => {} : console.log).call(
    null,
    ...logWrite(`[${!actor ? 'cmus' : actor === 1 ? 'bridge' : 'remote'}:${underline(`${action}`.padStart(9, ' '))}]:`, message),
  );
}

function logWrite(...msgs) {
  if (stack.logfile.path) stack.logfile.stream.write(format(...msgs, '\n').replace(/\x1b\[\d+m/g, ''));
  return msgs;
}

function pushArg(actor, args) {
  const result = spawnSync(
    stack.binary,
    (stack.args[actor].includes('%') ? ['-C', `format_print ${stack.args[actor]}`, args] : [stack.args[actor], args]).filter(
      v => !!v || v === 0,
    ),
  )
    .stdout.toString()
    .trim();
  if (!['status', 'bitrate', 'play_count'].includes(actor)) updateMetaSlice();
  return result;
}

function createAlbumArt() {
  const tmpfile = join(
    stack.tmp.dir,
    `${getThis('album')
      .toLowerCase()
      .replace(/['"\s,]/g, '_')}.jpg`,
  );
  return {
    tmpfile,
    status: existsSync(tmpfile)
      ? 1
      : !spawnSync('ffmpeg', [
          '-i',
          dataSlice.cores.file,
          '-an',
          // '-vf',
          // 'scale=-2:170',
          '-vsync',
          '2',
          '-y',
          tmpfile,
        ]).status
        ? 0
        : -1,
  };
}

function updateStatics(stopped) {
  if (stopped) {
    [player.metadata, player.playbackStatus] = [{}, 'Stopped'];
    return;
  }
  log(1, 'playlist', `${green('(\u2022)')} Now Playing: "${getThis()}"`);
  log(1, 'playlist', `|- ${cyan('(i)')} Music Location: "${dataSlice.cores.file}"`);
  updateAlbumArt(createAlbumArt());
  player.metadata = getMetadata();
}

function getStaticArtURL() {
  const dir = dirname(dataSlice.cores.file);
  const art = ['cover', 'folder']
    .flatMap(v => [v, v.replace(/^\w/, c => c.toUpperCase())])
    .flatMap(v => ['.png', '.jpg'].map(e => join(dir, `${v}${e}`)))
    .find(existsSync);
  return art;
}
function updateAlbumArt({status, tmpfile}) {
  if (~status) {
    if (status) log(1, 'albumart', `${cyan('[~]')} Using already existing album art for "${getThis()}"`);
    else log(1, 'albumart', `${green('[+]')} Album art for "${getThis()}" extracted successfully`);
    log(1, 'albumart', `|- ${cyan('(i)')} Location: "${tmpfile}"`);
  } else {
    log(1, 'albumart', `${red('[!]')} Album art generation for "${getThis()}" failed`);
    log(1, 'albumart', `${cyan('[.]')} Checking static album art for "${getThis()}"`);
    if (!(tmpfile = getStaticArtURL()))
      return log(1, 'albumart', `|-${red('[!]')} Static album art for "${getThis()}" does not exist`);
    log(1, 'albumart', `|- ${cyan('[~]')} Static album art for "${getThis()}" located!`);
    log(1, 'albumart', `|- ${cyan('(i)')} Location: "${tmpfile}"`);
  }
  dataSlice.cores.art = tmpfile;
  return undefined;
}

function updateMetaSlice() {
  const status = pushArg('status')
    .split(scanners.cmdCut)
    .filter(v => !!v);
  const [staticFile, staticArt, staticVolume, staticPosition] = [
    dataSlice.cores.file,
    dataSlice.cores.art,
    getBalancedVolume(),
    getPosition(),
  ];
  dataSlice = {cores: {}, tag: {}, set: {}, raw: status};
  if (!status.length) return checkActivity();
  status.forEach(line => {
    const [, mnemonic, key, value, rootKey, rootValue] = line.match(scanners.statusParse);
    if (mnemonic) dataSlice[mnemonic][key] = value;
    else dataSlice.cores[rootKey] = rootValue;
  });
  dataSlice.cores.art = staticArt;
  dataSlice.tag.bitrate = pushArg('bitrate') | 0;
  dataSlice.tag.play_count = pushArg('play_count');
  checkActivity(true);
  if (dataSlice.cores.file !== staticFile) updateStatics();
  if (getPosition() !== staticPosition) player.position = getPosition();
  if (getBalancedVolume() !== staticVolume) player.volume = getBalancedVolume();
  return true;
}

function attachEvents() {
  Object.entries(stack.events).forEach(([event, actor]) =>
    player.on(event, (...args) => (log(2, 'command', `${green('[:]')} Recieved \`${event}\``), actor(...args))),
  );
}

function initNativeCmus() {
  log(1, 'init', 'Initialized `cmus`');
  stack.cmus_process = spawn('cmus', {stdio: 'inherit'})
    .on('close', () => (stack.cmus_process.killed = true))
    .on('close', closeApp);
  return stack.cmus_process;
}

function initClientMonitor(time) {
  setInterval(() => {
    checkStatics();
    if (updateMetaSlice()) player.playbackStatus = getStatus();
  }, time);
  updateMetaSlice();
  player.playbackStatus = getStatus();
  player.position = getPosition();
}

function checkTmp() {
  if (!existsSync(stack.tmp.dir)) mkdirSync(stack.tmp.dir);
  if (!existsSync(stack.tmp.logdir)) mkdirSync(stack.tmp.logdir);
  if (dataSlice.cores.art && !existsSync(dataSlice.cores.art)) {
    log(1, 'status', `${red('[!]')} Album art deleted`);
    updateAlbumArt(createAlbumArt());
    log(1, 'status', `${green('[\u2022]')} Album art recreated`);
  }
}

function checkStatics(force) {
  checkTmp();
  if (existsSync(stack.tmp.lock) && force) {
    log(1, 'init', `${red('[!]')} cmus-client is already running or was terminated abruptly, lock file: ${stack.tmp.lock}`),
      closeApp(true);
  } else writeFileSync(stack.tmp.lock, '');
}

function checkArgs() {
  if (process.argv.includes('-q')) {
    if (existsSync(stack.tmp.lock)) {
      unlinkSync(stack.tmp.lock);
      if (existsSync(stack.tmp.lock)) console.log(`${red('[!] Failed to unlink the lock file')}`);
      else console.log(`${green('[\u2022]')} Successfully unlinked the lock file`), process.exit();
    } else console.log(`${yellow('[i] Lock file is non existent')}`), process.exit();
  }

  if (process.argv.includes('-x')) {
    readdirSync(stack.tmp.logdir).map(logfile => unlinkSync(join(stack.tmp.logdir, logfile))),
      console.log(`${green('[\u2022]')} Successfully removed all log files`);
    process.exit();
  }
}

function checkActivity(connected) {
  if (stack.state < 1 && connected) (stack.state = 1), log(1, 'status', `${green('[+]')} cmus connected`);
  else if (!~stack.state && !connected) (stack.state = 0), log(1, 'status', `${cyan('[-]')} awaiing cmus connection`);
  else if (stack.state && !connected)
    (stack.state = -1), log(1, 'status', `${red('[-]')} cmus disconnected`), updateStatics(true);
}

function checkCmusActivity() {
  return !spawnSync('ps -e | grep -e "\\bcmus\\b"', {shell: true}).status;
}

function closeApp(skipclean) {
  function carryOn() {
    if (!skipclean && existsSync(stack.tmp.lock)) {
      unlinkSync(stack.tmp.lock);
      if (existsSync(stack.tmp.lock)) log(1, 'cleanup', `${red('[!] Failed to unlink the lock file')}`);
      else log(1, 'cleanup', `${green('[\u2022]')} Successfully unlinked the lock file`);
    }
    process.exit();
  }
  if (stack.cmus_process && !stack.cmus_process.killed) stack.cmus_process.on('close', carryOn).kill();
  else carryOn();
}

(function main(logfile) {
  log(1, 'init', 'cmus-client starting...');
  checkTmp();
  checkArgs();

  checkStatics(true);
  setLogFile(logfile || stack.tmp.logdir);

  if (!checkCmusActivity()) initNativeCmus();
  else log(1, 'init', `${cyan('[~]')} cmus already running, connecting to it`);

  attachEvents();

  log(1, 'init', `${green('[+]')} cmus-client launched and listening!`);
  initClientMonitor(500);

  process.on('exit', closeApp).on('SIGINT', closeApp);
})(process.argv[2]);
