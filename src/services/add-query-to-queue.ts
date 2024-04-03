/* eslint-disable complexity */
import {ChatInputCommandInteraction, GuildMember} from 'discord.js';
import {URL} from 'node:url';
import {inject, injectable} from 'inversify';
import shuffle from 'array-shuffle';
import {TYPES} from '../types.js';
import GetSongs from '../services/get-songs.js';
import {MediaSource, SongMetadata, STATUS} from './player.js';
import PlayerManager from '../managers/player.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getMemberVoiceChannel, getMostPopularVoiceChannel} from '../utils/channels.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {SponsorBlock} from 'sponsorblock-api';
import Config from './config';

@injectable()
export default class AddQueryToQueue {
  private readonly sbClient?: SponsorBlock;
  private sbClientTimeout = false;

  constructor(@inject(TYPES.Services.GetSongs) private readonly getSongs: GetSongs,
    @inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager,
    @inject(TYPES.Config) private readonly config: Config) {
    this.sbClient = config.ENABLE_SPONSORBLOCK
      ? new SponsorBlock('muse-sb-integration') // UserID matters only for submissions
      : undefined;
  }

  public async addToQueue({
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
    interaction,
  }: {
    query: string;
    addToFrontOfQueue: boolean;
    shuffleAdditions: boolean;
    shouldSplitChapters: boolean;
    interaction: ChatInputCommandInteraction;
  }): Promise<void> {
    const guildId = interaction.guild!.id;
    const player = this.playerManager.get(guildId);
    const wasPlayingSong = player.getCurrent() !== null;

    const [targetVoiceChannel] = getMemberVoiceChannel(interaction.member as GuildMember) ?? getMostPopularVoiceChannel(interaction.guild!);

    const settings = await getGuildSettings(guildId);

    const {playlistLimit} = settings;

    await interaction.deferReply();

    let newSongs: SongMetadata[] = [];
    let extraMsg = '';

    // Test if it's a complete URL
    try {
      const url = new URL(query);

      const YOUTUBE_HOSTS = [
        'www.youtube.com',
        'youtu.be',
        'youtube.com',
        'music.youtube.com',
        'www.music.youtube.com',
      ];

      if (YOUTUBE_HOSTS.includes(url.host)) {
        // YouTube source
        if (url.searchParams.get('list')) {
          // YouTube playlist
          newSongs.push(...await this.getSongs.youtubePlaylist(url.searchParams.get('list')!, shouldSplitChapters));
        } else {
          const songs = await this.getSongs.youtubeVideo(url.href, shouldSplitChapters);

          if (songs) {
            newSongs.push(...songs);
          } else {
            throw new Error('that doesn\'t exist');
          }
        }
      } else if (url.protocol === 'spotify:' || url.host === 'open.spotify.com') {
        const [convertedSongs, nSongsNotFound, totalSongs] = await this.getSongs.spotifySource(query, playlistLimit, shouldSplitChapters);

        if (totalSongs > playlistLimit) {
          extraMsg = `a random sample of ${playlistLimit} songs was taken`;
        }

        if (totalSongs > playlistLimit && nSongsNotFound !== 0) {
          extraMsg += ' and ';
        }

        if (nSongsNotFound !== 0) {
          if (nSongsNotFound === 1) {
            extraMsg += '1 song was not found';
          } else {
            extraMsg += `${nSongsNotFound.toString()} songs were not found`;
          }
        }

        newSongs.push(...convertedSongs);
      } else {
        const song = await this.getSongs.httpLiveStream(query);

        if (song) {
          newSongs.push(song);
        } else {
          throw new Error('that doesn\'t exist');
        }
      }
    } catch (_: unknown) {
      // Not a URL, must search YouTube
      const songs = await this.getSongs.youtubeVideoSearch(query, shouldSplitChapters);

      if (songs) {
        newSongs.push(...songs);
      } else {
        throw new Error('that doesn\'t exist');
      }
    }

    if (newSongs.length === 0) {
      throw new Error('no songs found');
    }

    if (shuffleAdditions) {
      newSongs = shuffle(newSongs);
    }

    if (this.config.ENABLE_SPONSORBLOCK && !this.sbClientTimeout) {
      newSongs = await this.enrichWithSkipSegments(newSongs);
    }

    newSongs.forEach(song => {
      player.add({
        ...song,
        addedInChannelId: interaction.channel!.id,
        requestedBy: interaction.member!.user.id,
      }, {immediate: addToFrontOfQueue ?? false});
    });

    const firstSong = newSongs[0];

    let statusMsg = '';

    if (player.voiceConnection === null) {
      await player.connect(targetVoiceChannel);

      // Resume / start playback
      await player.play();

      if (wasPlayingSong) {
        statusMsg = 'resuming playback';
      }

      await interaction.editReply({
        embeds: [buildPlayingMessageEmbed(player)],
      });
    } else if (player.status === STATUS.IDLE) {
      // Player is idle, start playback instead
      await player.play();
    }

    // Build response message
    if (statusMsg !== '') {
      if (extraMsg === '') {
        extraMsg = statusMsg;
      } else {
        extraMsg = `${statusMsg}, ${extraMsg}`;
      }
    }

    if (extraMsg !== '') {
      extraMsg = ` (${extraMsg})`;
    }

    if (newSongs.length === 1) {
      await interaction.editReply(`u betcha, **${firstSong.title}** added to the${addToFrontOfQueue ? ' front of the' : ''} queue${extraMsg}`);
    } else {
      await interaction.editReply(`u betcha, **${firstSong.title}** and ${newSongs.length - 1} other songs were added to the queue${extraMsg}`);
    }
  }

  private async enrichWithSkipSegments(songs: SongMetadata[]) {
    const promises = songs.map(async song => {
      if (!this.sbClient
          || this.sbClientTimeout
          || song.source !== MediaSource.Youtube
          || !song.url) {
        return song;
      }

      try {
        return await this.sbClient.getSegments(song.url, ['music_offtopic']).then(segments => {
          const skipSegments = segments
            .sort((a, b) => a.startTime - b.startTime)
            .reduce((acc: Array<{startTime: number; endTime: number}>, {startTime, endTime}) => {
              const previousSegment = acc[acc.length - 1];
              // If segments overlap merge
              if (previousSegment && previousSegment.endTime > startTime) {
                acc[acc.length - 1].endTime = endTime;
              } else {
                acc.push({startTime, endTime});
              }

              return acc;
            }, []);

          const intro = skipSegments[0];
          const outro = skipSegments.at(-1);
          if (outro && outro?.endTime >= song.length - 2) {
            song.length -= outro.endTime - outro.startTime;
          }

          if (intro?.startTime <= 2) {
            song.offset = Math.floor(intro.endTime);
            song.length -= song.offset;
          }

          return song;
        });
      } catch (e) {
        if (!(e instanceof Error)) {
          console.error('Unexpected event occured while fecthing skip segments : ', e);
          return song;
        }

        if (!e.message.includes('404')) {
          // Don't log 404 response, it just means that there are no segments for given video
          console.error(`Could not fetch skip segments for "${song.url}" :`, e);
        }

        if (e.message.includes('504')) {
          // Stop fetching SponsorBlock data when servers are down
          this.sbClientTimeout = true;
          // eslint-disable-next-line no-return-assign
          setTimeout(() => this.sbClientTimeout = false, 5 * 60_000);
        }

        return song;
      }
    });

    return Promise.all(promises);
  }
}
