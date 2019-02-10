#!/usr/bin/env node

const fs = require('fs'),
  os = require('os'),
  url = require('url'),
  path = require('path'),
  util = require('util'),
  child_process = require('child_process'),
  querystring = require('querystring'),
  chalk = require('chalk'),
  Player = require('mpris-service');

var player = Player({
  name: 'cmus',
  identity: 'CMUS Media Player',
  supportedUriSchemes: ['file'],
  supportedMimeTypes: ['audio/mpeg', 'application/ogg', 'audio/x-vorbis+ogg', 'audio/x-flac'],
  supportedInterfaces: ['player'],
});

player.canRaise = false;
player.Fullscreen = false;
player.CanSetFullscreen = false;

let scanners = {
  cmdCut: /\s*\n\s*/g,
  statusParse: /(?:(set|tag)\s(\w+)\s(.+)|(\w+)\s(.+))/,
  artistsParse: /\b\s*(?:&|,|(?:(?:feat(?:uring)?|f[et])\.))\s*/gi,
};

let dataSlice = {cores: {}, tag: {}, set: {}, raw: null};
let tmpdir = path.join(os.tmpdir(), 'cmus-dir');

let stack = {
  state: -1,
  binary: 'cmus-remote',
  cmus_process: null,
  tmp: {
    dir: tmpdir,
    albumart: '',
    lock: path.join(tmpdir, '.lock'),
    logdir: path.join(tmpdir, 'logs'),
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
      let _volume = getBalancedVolume(true) | 0;
      let __volume = `${volume < _volume ? '-' : '+'}${Math.abs(_volume - volume)}`;
      log(2, 'volume', `Update [L|R]: ${__volume}%`);
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
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    let time = new Date();
    file = path.join(
      file,
      `cmus_log_${time.getDate()}-${time.getMonth()}-${time.getFullYear()}_${time.getHours()}-${time.getMinutes()}-${time.getSeconds()}`
    );
  }
  stack.logfile.path = file;
  stack.logfile.stream = fs.createWriteStream(file);
  log(1, 'logs', `Log file: "${stack.logfile.path}"`);
}

function getThis(data = 'title') {
  return `${dataSlice.tag.artist}${dataSlice.tag[data] ? ` - ${dataSlice.tag[data]}` : ''}`;
}

function getBalancedVolume(host) {
  return ((dataSlice.set.vol_left | 0) + (dataSlice.set.vol_left | 0)) / (host ? 2 : 200);
}

function getPosition(parse) {
  let val = Math.round(dataSlice.cores.position) * 1000 ** 2;
  return !parse ? val : parsePosition(val);
}

function getDuration(parse) {
  let val = Math.round(dataSlice.cores.duration) * 1000 ** 2;
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
    'mpris:artUrl': querystring.unescape(url.pathToFileURL(dataSlice.cores.art || '')),
    'mpris:trackid': player.objectPath(`tracklist/${parseSlice('tag', 'tracknumber')}`),

    'xesam:url': url.pathToFileURL(dataSlice.cores.file).href,
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
  let time = new Date(position / 1000);
  return `${`${time.getMinutes()}`.padStart(2, 0)}:${`${time.getSeconds()}`.padStart(2, 0)}`;
}

function log(actor, action, message) {
  (stack.cmus_process && !stack.cmus_process.killed ? () => {} : console.log).call(
    null,
    ...logWrite(
      `[${!actor ? 'cmus' : actor == 1 ? 'bridge' : 'remote'}:${chalk.underline(`${action}`.padStart(9, ' '))}]:`,
      message
    )
  );
}

function logWrite(...msgs) {
  if (stack.logfile.path) stack.logfile.stream.write(util.format(...msgs, '\n').replace(/\x1b\[\d+m/g, ''));
  return msgs;
}

function pushArg(actor, args) {
  let result = child_process
    .spawnSync(
      stack.binary,
      (stack.args[actor].includes('%') ? ['-C', `format_print ${stack.args[actor]}`, args] : [stack.args[actor], args]).filter(
        v => !!v || v == 0
      )
    )
    .stdout.toString()
    .trim();
  if (!['status', 'bitrate', 'play_count'].includes(actor)) updateMetaSlice();
  return result;
}

function createAlbumArt() {
  let tmpfile = path.join(
    stack.tmp.dir,
    `${getThis('album')
      .toLowerCase()
      .replace(/['"\s,]/g, '_')}.jpg`
  );
  return {
    tmpfile,
    status: fs.existsSync(tmpfile)
      ? 1
      : !child_process.spawnSync('ffmpeg', [
          '-i',
          dataSlice.cores.file,
          '-an',
          '-vf',
          'scale=-2:170',
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
  if (stopped) return (player.metadata = {}), (player.playbackStatus = 'Stopped');
  log(1, 'playlist', `${chalk.green('(\u2022)')} Now Playing: "${getThis()}"`);
  log(1, 'playlist', `|- ${chalk.cyan('(i)')} Music Location: "${dataSlice.cores.file}"`);
  updateAlbumArt(createAlbumArt());
  player.metadata = getMetadata();
}

function updateAlbumArt({status, tmpfile}) {
  if (~status) {
    if (status) log(1, 'albumart', `${chalk.cyan('[~]')} Using already existing album art for "${getThis()}"`);
    else log(1, 'albumart', `${chalk.green('[+]')} Album art for "${getThis()}" extracted successfully`);
    log(1, 'albumart', `|- ${chalk.cyan('(i)')} Location: "${tmpfile}"`);
    dataSlice.cores.art = tmpfile;
  } else log(1, 'albumart', `${chalk.red('[!]')} Album art generation for "${getThis()}" failed`);
}

function updateMetaSlice() {
  let status = pushArg('status')
      .split(scanners.cmdCut)
      .filter(v => !!v),
    [staticFile, staticArt, staticVolume, staticPosition] = [
      dataSlice.cores.file,
      dataSlice.cores.art,
      getBalancedVolume(),
      getPosition(),
    ];
  dataSlice = {cores: {}, tag: {}, set: {}, raw: status};
  if (!status.length) return checkActivity();
  status.map(line => {
    let [, mnemonic, key, value, root_key, root_value] = line.match(scanners.statusParse);
    if (mnemonic) dataSlice[mnemonic][key] = value;
    else dataSlice.cores[root_key] = root_value;
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
    player.on(event, (...args) => (log(2, 'command', `${chalk.green('[:]')} Recieved \`${event}\``), actor(...args)))
  );
}

function initNativeCmus() {
  log(1, 'init', 'Initialized `cmus`');
  stack.cmus_process = child_process
    .spawn('cmus', {stdio: 'inherit'})
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
  if (!fs.existsSync(stack.tmp.dir)) fs.mkdirSync(stack.tmp.dir);
  if (!fs.existsSync(stack.tmp.logdir)) fs.mkdirSync(stack.tmp.logdir);
  if (dataSlice.cores.art && !fs.existsSync(dataSlice.cores.art)) {
    log(1, 'status', `${chalk.red('[!]')} Album art deleted`);
    updateAlbumArt(createAlbumArt());
    log(1, 'status', `${chalk.green('[\u2022]')} Album art recreated`);
  }
}

function checkStatics(force) {
  checkTmp();
  if (fs.existsSync(stack.tmp.lock) && force) {
    log(1, 'init', `${chalk.red('[!]')} cmus-client is already running or was terminated abruptly, lock file: ${stack.tmp.lock}`),
      closeApp(true);
  } else fs.writeFileSync(stack.tmp.lock, '');
}

function checkArgs() {
  if (process.argv.includes('-q')) {
    if (fs.existsSync(stack.tmp.lock)) {
      fs.unlinkSync(stack.tmp.lock);
      if (fs.existsSync(stack.tmp.lock)) console.log(`${chalk.red('[!] Failed to unlink the lock file')}`);
      else console.log(`${chalk.green('[\u2022]')} Successfully unlinked the lock file`), process.exit();
    } else console.log(`${chalk.yellow('[i] Lock file is non existent')}`), process.exit();
  }

  if (process.argv.includes('-x')) {
    fs.readdirSync(stack.tmp.logdir).map(logfile => fs.unlinkSync(path.join(stack.tmp.logdir, logfile))),
      console.log(`${chalk.green('[\u2022]')} Successfully removed all log files`);
    process.exit();
  }
}

function checkActivity(connected) {
  if (stack.state < 1 && connected) (stack.state = 1), log(1, 'status', `${chalk.green('[+]')} cmus connected`);
  else if (!~stack.state && !connected) (stack.state = 0), log(1, 'status', `${chalk.cyan('[-]')} awaiing cmus connection`);
  else if (stack.state && !connected)
    (stack.state = -1), log(1, 'status', `${chalk.red('[-]')} cmus disconnected`), updateStatics(true);
}

function checkCmusActivity() {
  return !child_process.spawnSync('ps -e | grep cmus', {shell: true}).status;
}

function closeApp(skipclean) {
  function carryOn() {
    if (!skipclean && fs.existsSync(stack.tmp.lock)) {
      fs.unlinkSync(stack.tmp.lock);
      if (fs.existsSync(stack.tmp.lock)) log(1, 'cleanup', `${chalk.red('[!] Failed to unlink the lock file')}`);
      else log(1, 'cleanup', `${chalk.green('[\u2022]')} Successfully unlinked the lock file`);
    }
    process.exit();
  }
  if (stack.cmus_process && !stack.cmus_process.killed) stack.cmus_process.on('close', carryOn).kill();
  else carryOn();
}

void (function main(logfile) {
  log(1, 'init', 'cmus-client starting...');
  checkTmp();
  checkArgs();

  checkStatics(true);
  setLogFile(logfile || stack.tmp.logdir);

  if (!checkCmusActivity()) initNativeCmus();
  else log(1, 'init', `${chalk.cyan('[~]')} cmus already running, connecting to it`);

  attachEvents();

  log(1, 'init', `${chalk.green('[+]')} cmus-client launched and listening!`);
  initClientMonitor(500);

  process.on('exit', closeApp).on('SIGINT', closeApp);
})(process.argv[2]);
