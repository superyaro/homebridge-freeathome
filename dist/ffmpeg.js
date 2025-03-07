'use strict';
var uuid, Service, Characteristic, StreamController;
var crypto = require('crypto');
var fs = require('fs');
var ip = require('ip');
var spawn = require('child_process').spawn;
module.exports = {
    FFMPEG: FFMPEG
};
function FFMPEG(hap, cameraConfig, log, videoProcessor) {
    uuid = hap.uuid;
    Service = hap.Service;
    Characteristic = hap.Characteristic;
    StreamController = hap.StreamController;
    this.log = log;
    var ffmpegOpt = cameraConfig.videoConfig;
    this.name = cameraConfig.name;
    this.vcodec = ffmpegOpt.vcodec;
    this.videoProcessor = videoProcessor || 'ffmpeg';
    this.audio = ffmpegOpt.audio;
    this.acodec = ffmpegOpt.acodec;
    this.packetsize = ffmpegOpt.packetSize;
    this.fps = ffmpegOpt.maxFPS || 10;
    this.maxBitrate = ffmpegOpt.maxBitrate || 300;
    this.debug = ffmpegOpt.debug;
    this.additionalCommandline = ffmpegOpt.additionalCommandline || '-tune zerolatency';
    if (!ffmpegOpt.source) {
        throw new Error("Missing source for camera.");
    }
    this.ffmpegSource = ffmpegOpt.source;
    this.ffmpegImageSource = ffmpegOpt.stillImageSource;
    this.services = [];
    this.streamControllers = [];
    this.pendingSessions = {};
    this.ongoingSessions = {};
    var numberOfStreams = ffmpegOpt.maxStreams || 2;
    var videoResolutions = [];
    this.maxWidth = ffmpegOpt.maxWidth || 1280;
    this.maxHeight = ffmpegOpt.maxHeight || 720;
    var maxFPS = (this.fps > 30) ? 30 : this.fps;
    if (this.maxWidth >= 320) {
        if (this.maxHeight >= 240) {
            videoResolutions.push([320, 240, maxFPS]);
            if (maxFPS > 15) {
                videoResolutions.push([320, 240, 15]);
            }
        }
        if (this.maxHeight >= 180) {
            videoResolutions.push([320, 180, maxFPS]);
            if (maxFPS > 15) {
                videoResolutions.push([320, 180, 15]);
            }
        }
    }
    if (this.maxWidth >= 480) {
        if (this.maxHeight >= 360) {
            videoResolutions.push([480, 360, maxFPS]);
        }
        if (this.maxHeight >= 270) {
            videoResolutions.push([480, 270, maxFPS]);
        }
    }
    if (this.maxWidth >= 640) {
        if (this.maxHeight >= 480) {
            videoResolutions.push([640, 480, maxFPS]);
        }
        if (this.maxHeight >= 360) {
            videoResolutions.push([640, 360, maxFPS]);
        }
    }
    if (this.maxWidth >= 1280) {
        if (this.maxHeight >= 960) {
            videoResolutions.push([1280, 960, maxFPS]);
        }
        if (this.maxHeight >= 720) {
            videoResolutions.push([1280, 720, maxFPS]);
        }
    }
    if (this.maxWidth >= 1920) {
        if (this.maxHeight >= 1080) {
            videoResolutions.push([1920, 1080, maxFPS]);
        }
    }
    let options = {
        proxy: false,
        srtp: true,
        video: {
            resolutions: videoResolutions,
            codec: {
                profiles: [0, 1, 2],
                levels: [0, 1, 2]
            }
        },
        audio: {
            codecs: [
                {
                    type: "OPUS",
                    samplerate: 24
                },
                {
                    type: "AAC-eld",
                    samplerate: 16
                }
            ]
        }
    };
    this.createCameraControlService();
    this._createStreamControllers(numberOfStreams, options);
}
FFMPEG.prototype.handleCloseConnection = function (connectionID) {
    this.streamControllers.forEach(function (controller) {
        controller.handleCloseConnection(connectionID);
    });
};
FFMPEG.prototype.handleSnapshotRequest = function (request, callback) {
    let resolution = request.width + 'x' + request.height;
    var imageSource = this.ffmpegImageSource !== undefined ? this.ffmpegImageSource : this.ffmpegSource;
    let ffmpeg = spawn(this.videoProcessor, (imageSource + ' -t 1 -s ' + resolution + ' -f image2 -').split(' '), { env: process.env });
    var imageBuffer = Buffer(0);
    this.log("Snapshot from " + this.name + " at " + resolution);
    if (this.debug)
        console.log('ffmpeg ' + imageSource + ' -t 1 -s ' + resolution + ' -f image2 -');
    ffmpeg.stdout.on('data', function (data) {
        imageBuffer = Buffer.concat([imageBuffer, data]);
    });
    let self = this;
    ffmpeg.on('error', function (error) {
        self.log("An error occurs while making snapshot request");
        self.debug ? self.log(error) : null;
    });
    ffmpeg.on('close', function (code) {
        callback(undefined, imageBuffer);
    }.bind(this));
};
FFMPEG.prototype.prepareStream = function (request, callback) {
    var sessionInfo = {};
    let sessionID = request["sessionID"];
    let targetAddress = request["targetAddress"];
    sessionInfo["address"] = targetAddress;
    var response = {};
    let videoInfo = request["video"];
    if (videoInfo) {
        let targetPort = videoInfo["port"];
        let srtp_key = videoInfo["srtp_key"];
        let srtp_salt = videoInfo["srtp_salt"];
        let ssrcSource = crypto.randomBytes(4);
        ssrcSource[0] = 0;
        let ssrc = ssrcSource.readInt32BE(0, true);
        let videoResp = {
            port: targetPort,
            ssrc: ssrc,
            srtp_key: srtp_key,
            srtp_salt: srtp_salt
        };
        response["video"] = videoResp;
        sessionInfo["video_port"] = targetPort;
        sessionInfo["video_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
        sessionInfo["video_ssrc"] = ssrc;
    }
    let audioInfo = request["audio"];
    if (audioInfo) {
        let targetPort = audioInfo["port"];
        let srtp_key = audioInfo["srtp_key"];
        let srtp_salt = audioInfo["srtp_salt"];
        let ssrcSource = crypto.randomBytes(4);
        ssrcSource[0] = 0;
        let ssrc = ssrcSource.readInt32BE(0, true);
        let audioResp = {
            port: targetPort,
            ssrc: ssrc,
            srtp_key: srtp_key,
            srtp_salt: srtp_salt
        };
        response["audio"] = audioResp;
        sessionInfo["audio_port"] = targetPort;
        sessionInfo["audio_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
        sessionInfo["audio_ssrc"] = ssrc;
    }
    let currentAddress = ip.address();
    var addressResp = {
        address: currentAddress
    };
    if (ip.isV4Format(currentAddress)) {
        addressResp["type"] = "v4";
    }
    else {
        addressResp["type"] = "v6";
    }
    response["address"] = addressResp;
    this.pendingSessions[uuid.unparse(sessionID)] = sessionInfo;
    callback(response);
};
FFMPEG.prototype.handleStreamRequest = function (request) {
    var sessionID = request["sessionID"];
    var requestType = request["type"];
    if (sessionID) {
        let sessionIdentifier = uuid.unparse(sessionID);
        if (requestType == "start") {
            var sessionInfo = this.pendingSessions[sessionIdentifier];
            if (sessionInfo) {
                var width = 1280;
                var height = 720;
                var fps = this.fps || 30;
                var vbitrate = this.maxBitrate;
                var abitrate = 32;
                var asamplerate = 16;
                var vcodec = this.vcodec || 'libx264';
                var acodec = this.acodec || 'libfdk_aac';
                var packetsize = this.packetsize || 1316;
                var additionalCommandline = this.additionalCommandline;
                let videoInfo = request["video"];
                if (videoInfo) {
                    width = videoInfo["width"];
                    height = videoInfo["height"];
                    let expectedFPS = videoInfo["fps"];
                    if (expectedFPS < fps) {
                        fps = expectedFPS;
                    }
                    if (videoInfo["max_bit_rate"] < vbitrate) {
                        vbitrate = videoInfo["max_bit_rate"];
                    }
                }
                let audioInfo = request["audio"];
                if (audioInfo) {
                    abitrate = audioInfo["max_bit_rate"];
                    asamplerate = audioInfo["sample_rate"];
                }
                let targetAddress = sessionInfo["address"];
                let targetVideoPort = sessionInfo["video_port"];
                let videoKey = sessionInfo["video_srtp"];
                let videoSsrc = sessionInfo["video_ssrc"];
                let targetAudioPort = sessionInfo["audio_port"];
                let audioKey = sessionInfo["audio_srtp"];
                let audioSsrc = sessionInfo["audio_ssrc"];
                let ffmpegCommand = this.ffmpegSource + ' -map 0:0' +
                    ' -vcodec ' + vcodec +
                    ' -pix_fmt yuv420p' +
                    ' -r ' + fps +
                    ' -f rawvideo' +
                    ' ' + additionalCommandline +
                    ((vcodec !== 'copy') ? (' -vf scale=' + width + ':' + height) : '') +
                    ' -b:v ' + vbitrate + 'k' +
                    ' -bufsize ' + vbitrate + 'k' +
                    ' -maxrate ' + vbitrate + 'k' +
                    ' -payload_type 99' +
                    ' -ssrc ' + videoSsrc +
                    ' -f rtp' +
                    ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
                    ' -srtp_out_params ' + videoKey.toString('base64') +
                    ' srtp://' + targetAddress + ':' + targetVideoPort +
                    '?rtcpport=' + targetVideoPort +
                    '&localrtcpport=' + targetVideoPort +
                    '&pkt_size=' + packetsize;
                if (this.audio) {
                    ffmpegCommand += ' -map 0:1' +
                        ' -acodec ' + acodec +
                        ' -profile:a aac_eld' +
                        ' -flags +global_header' +
                        ' -f null' +
                        ' -ar ' + asamplerate + 'k' +
                        ' -b:a ' + abitrate + 'k' +
                        ' -bufsize ' + abitrate + 'k' +
                        ' -ac 1' +
                        ' -payload_type 110' +
                        ' -ssrc ' + audioSsrc +
                        ' -f rtp' +
                        ' -srtp_out_suite AES_CM_128_HMAC_SHA1_80' +
                        ' -srtp_out_params ' + audioKey.toString('base64') +
                        ' srtp://' + targetAddress + ':' + targetAudioPort +
                        '?rtcpport=' + targetAudioPort +
                        '&localrtcpport=' + targetAudioPort +
                        '&pkt_size=' + packetsize;
                }
                let ffmpeg = spawn(this.videoProcessor, ffmpegCommand.split(' '), { env: process.env });
                this.log("Start streaming video from " + this.name + " with " + width + "x" + height + "@" + vbitrate + "kBit");
                if (this.debug) {
                    console.log("ffmpeg " + ffmpegCommand);
                }
                ffmpeg.stderr.on('data', function (data) {
                    if (this.debug) {
                        console.log(data.toString());
                    }
                });
                let self = this;
                ffmpeg.on('error', function (error) {
                    self.log("An error occurs while making stream request");
                    self.debug ? self.log(error) : null;
                });
                ffmpeg.on('close', (code) => {
                    if (code == null || code == 0 || code == 255) {
                        self.log("Stopped streaming");
                    }
                    else {
                        self.log("ERROR: FFmpeg exited with code " + code);
                        for (var i = 0; i < self.streamControllers.length; i++) {
                            var controller = self.streamControllers[i];
                            if (controller.sessionIdentifier === sessionID) {
                                controller.forceStop();
                            }
                        }
                    }
                });
                this.ongoingSessions[sessionIdentifier] = ffmpeg;
            }
            delete this.pendingSessions[sessionIdentifier];
        }
        else if (requestType == "stop") {
            var ffmpegProcess = this.ongoingSessions[sessionIdentifier];
            if (ffmpegProcess) {
                ffmpegProcess.kill('SIGTERM');
            }
            delete this.ongoingSessions[sessionIdentifier];
        }
    }
};
FFMPEG.prototype.createCameraControlService = function () {
    var controlService = new Service.CameraControl();
    this.services.push(controlService);
    if (this.audio) {
        var microphoneService = new Service.Microphone();
        this.services.push(microphoneService);
    }
};
FFMPEG.prototype._createStreamControllers = function (maxStreams, options) {
    let self = this;
    for (var i = 0; i < maxStreams; i++) {
        var streamController = new StreamController(i, options, self);
        self.services.push(streamController.service);
        self.streamControllers.push(streamController);
    }
};
