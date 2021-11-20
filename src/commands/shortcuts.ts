import {Message} from 'discord.js';
import {injectable} from 'inversify';
import {Shortcut, Settings} from '../models/index.js';
import errorMsg from '../utils/error-msg.js';
import Command from '.';

@injectable()
export default class implements Command {
  public name = 'shortcuts';
  public aliases = [];
  public examples = [
    ['shortcuts', 'show all shortcuts'],
    ['shortcuts set s skip', 'aliases `s` to `skip`'],
    ['shortcuts set party play https://www.youtube.com/watch?v=zK6oOJ1wz8k', 'aliases `party` to a specific play command'],
    ['shortcuts delete party', 'removes the `party` shortcut'],
  ];

  public async execute(msg: Message, args: string []): Promise<void> {
    if (args.length === 0) {
      // Get shortcuts for guild
      const shortcuts = await Shortcut.findAll({where: {guildId: msg.guild!.id}});

      if (shortcuts.length === 0) {
        await msg.channel.send('No shortcuts exist.');
        return;
      }

      // Get prefix for guild
      const settings = await Settings.findOne({where: {guildId: msg.guild!.id}});

      if (!settings) {
        return;
      }

      const {prefix} = settings;

      const res = shortcuts.reduce((accum, shortcut) => {
        accum += `${prefix}${shortcut.shortcut}: ${shortcut.command}\n`;

        return accum;
      }, '');

      await msg.channel.send(res);
    } else {
      const action = args[0];

      const shortcutName = args[1];

      switch (action) {
        case 'set': {
          const shortcut = await Shortcut.findOne({where: {guildId: msg.guild!.id, shortcut: shortcutName}});

          const command = args.slice(2).join(' ');

          const newShortcut = {shortcut: shortcutName, command, guildId: msg.guild!.id, authorId: msg.author.id};

          if (shortcut) {
            if (shortcut.authorId !== msg.author.id && msg.author.id !== msg.guild!.ownerId) {
              await msg.channel.send(errorMsg('You do\'nt have the permissions required to perform that action.'));
              return;
            }

            await shortcut.update(newShortcut);
            await msg.channel.send('Shortcut updated.');
          } else {
            await Shortcut.create(newShortcut);
            await msg.channel.send('Shortcut created');
          }

          break;
        }

        case 'delete': {
          // Check if shortcut exists
          const shortcut = await Shortcut.findOne({where: {guildId: msg.guild!.id, shortcut: shortcutName}});

          if (!shortcut) {
            await msg.channel.send(errorMsg('That shortcut doesn\'t exist.'));
            return;
          }

          // Check permissions
          if (shortcut.authorId !== msg.author.id && msg.author.id !== msg.guild!.ownerId) {
            await msg.channel.send(errorMsg('You do\'nt have the permissions required to perform that action.'));
            return;
          }

          await shortcut.destroy();

          await msg.channel.send('Shortcut removed.');

          break;
        }

        default: {
          await msg.channel.send(errorMsg('I don\'t recognize that command.'));
        }
      }
    }
  }
}
